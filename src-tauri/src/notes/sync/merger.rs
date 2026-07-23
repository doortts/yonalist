use crate::notes::date_index::{LocalTodayProvider, SystemLocalTodayProvider};
use crate::notes::error::NotesError;
use crate::notes::github_notifications::{
    compare_github_notification_timestamps, parse_github_plugin_meta_storage,
    serialize_github_plugin_meta_storage, GithubNotificationsPluginMeta,
    GITHUB_NOTIFICATIONS_PLUGIN_ID, GITHUB_NOTIFICATIONS_ROOT_ID, GITHUB_NOTIFICATIONS_TITLE,
};
use crate::notes::hlc::{self, Hlc};
use crate::notes::repository::{rebuild_derived_for_nodes_at, MAX_NOTES_EXPORT_DEPTH};
use crate::notes::schema::SYNC_REMOVE_TOPIC_PREFIX;
use crate::notes::sync::exporter::TRASH_TOPIC_ID;
use crate::notes::sync::topic_file::{
    derive_topic_filename, TopicAttachment, TopicContent, TopicDoc, TopicNode, TrashDoc,
};
use crate::notes::types::{NoteNodeKind, MAX_NOTE_ATTACHMENTS_PER_VAULT};
use rusqlite::{
    params, params_from_iter, Connection, OptionalExtension, Transaction, TransactionBehavior,
};
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

pub(crate) struct MergeCleanupIntent<'a> {
    pub(crate) marker_topic_id: &'a str,
    pub(crate) file_name: &'a str,
    pub(crate) source_hash: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SyncOwnership {
    topic_id: String,
    deleted: bool,
}

#[derive(Clone, Copy)]
enum MergeSource<'a> {
    Topic(&'a str),
    Trash,
}

fn topic_sync_ownership_ids(document: &TopicDoc) -> BTreeSet<String> {
    let mut ids = BTreeSet::from([document.id.clone()]);
    let mut stack = document.nodes.iter().collect::<Vec<_>>();
    while let Some(node) = stack.pop() {
        if let Some(id) = &node.id {
            ids.insert(id.clone());
        }
        stack.extend(node.children.iter());
    }
    ids
}

fn topic_node_has_plugin_meta(node: &TopicNode) -> bool {
    node.plugin_meta.is_some() || node.children.iter().any(topic_node_has_plugin_meta)
}

fn trash_sync_ownership_ids(document: &TrashDoc) -> BTreeSet<String> {
    let mut ids = document
        .purged
        .iter()
        .map(|tombstone| tombstone.id.clone())
        .collect::<BTreeSet<_>>();
    let mut stack = document.nodes.iter().collect::<Vec<_>>();
    while let Some(node) = stack.pop() {
        if let Some(id) = &node.id {
            ids.insert(id.clone());
        }
        if let Some((parent_id, _)) = &node.from {
            ids.insert(parent_id.clone());
        }
        stack.extend(node.children.iter());
    }
    ids
}

fn load_sync_ownership(
    transaction: &Transaction<'_>,
    node_ids: &BTreeSet<String>,
) -> Result<BTreeMap<String, SyncOwnership>, NotesError> {
    let mut rows = BTreeMap::<String, (Option<String>, bool)>::new();
    let mut frontier = node_ids.clone();
    while !frontier.is_empty() {
        let frontier_ids = frontier.into_iter().collect::<Vec<_>>();
        let mut next = BTreeSet::new();
        for chunk in frontier_ids.chunks(AFFECTED_ID_QUERY_CHUNK_SIZE) {
            let placeholders = std::iter::repeat_n("?", chunk.len())
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "SELECT id, parent_id, deleted_at IS NOT NULL \
                 FROM notes_nodes WHERE id IN ({placeholders})"
            );
            let mut statement = transaction
                .prepare(&sql)
                .map_err(|error| format!("Could not prepare Notes merge ownership: {error}"))?;
            let loaded = statement
                .query_map(params_from_iter(chunk.iter()), |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, bool>(2)?,
                    ))
                })
                .map_err(|error| format!("Could not inspect Notes merge ownership: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("Could not read Notes merge ownership: {error}"))?;
            for (id, parent_id, deleted) in loaded {
                if let Some(parent_id) = &parent_id {
                    next.insert(parent_id.clone());
                }
                rows.insert(id, (parent_id, deleted));
            }
        }
        next.retain(|id| !rows.contains_key(id));
        frontier = next;
    }

    let mut roots = BTreeMap::<String, String>::new();
    let mut ownership = BTreeMap::new();
    for node_id in node_ids {
        let Some((_, deleted)) = rows.get(node_id) else {
            continue;
        };
        let mut current = node_id.clone();
        let mut path = Vec::new();
        let topic_id = loop {
            if let Some(root) = roots.get(&current) {
                break root.clone();
            }
            if path.len() > MAX_NOTES_EXPORT_DEPTH || path.iter().any(|visited| visited == &current)
            {
                return Err("A merged Notes ownership chain is cyclic or too deep."
                    .to_string()
                    .into());
            }
            path.push(current.clone());
            let (parent_id, _) = rows.get(&current).ok_or_else(|| {
                NotesError::from(format!(
                    "Could not resolve Notes merge ownership ancestor {current}."
                ))
            })?;
            match parent_id {
                Some(parent_id) => current.clone_from(parent_id),
                None => break current.clone(),
            }
        };
        for visited in path {
            roots.insert(visited, topic_id.clone());
        }
        ownership.insert(
            node_id.clone(),
            SyncOwnership {
                topic_id,
                deleted: *deleted,
            },
        );
    }
    Ok(ownership)
}

fn mark_sync_ownership_changes(
    transaction: &Transaction<'_>,
    before: &BTreeMap<String, SyncOwnership>,
    after: &BTreeMap<String, SyncOwnership>,
    source: MergeSource<'_>,
) -> Result<(), NotesError> {
    let node_ids = before.keys().chain(after.keys()).collect::<BTreeSet<_>>();
    for node_id in node_ids {
        let previous = before.get(node_id);
        let current = after.get(node_id);
        if previous == current {
            continue;
        }

        if let Some(previous) = previous {
            if current.is_none() || !previous.deleted {
                if previous.topic_id == *node_id {
                    if topic_metadata_exists(transaction, &previous.topic_id)? {
                        mark_dirty(
                            transaction,
                            &format!("{SYNC_REMOVE_TOPIC_PREFIX}{}", previous.topic_id),
                        )?;
                    }
                } else if !matches!(source, MergeSource::Topic(topic) if topic == previous.topic_id)
                {
                    mark_dirty(transaction, &previous.topic_id)?;
                }
            }
            if previous.deleted
                && !current.is_some_and(|ownership| ownership.deleted)
                && !matches!(source, MergeSource::Trash)
            {
                mark_dirty(transaction, TRASH_TOPIC_ID)?;
            }
        }

        if let Some(current) = current {
            if current.deleted {
                if !matches!(source, MergeSource::Trash) {
                    mark_dirty(transaction, TRASH_TOPIC_ID)?;
                }
            } else if !matches!(source, MergeSource::Topic(topic) if topic == current.topic_id) {
                mark_dirty(transaction, &current.topic_id)?;
            }
        }
    }
    Ok(())
}

fn topic_metadata_exists(
    transaction: &Transaction<'_>,
    topic_id: &str,
) -> Result<bool, NotesError> {
    crate::notes::sync::topic_metadata_exists(transaction, topic_id)
        .map_err(|error| format!("Could not inspect Notes topic file metadata: {error}").into())
}

pub(crate) fn merge_topic_doc(
    connection: &mut Connection,
    document: &TopicDoc,
) -> Result<MergeReport, NotesError> {
    if document.root.format_version >= 3 || topic_document_has_v3_fields(document) {
        return Err("A v3 Notes document must use the explicit v3 merge path."
            .to_string()
            .into());
    }
    merge_topic_doc_with_cleanup_mode(connection, document, None, None, false)
}

/// Explicit dormant v3 merge entry point. Production callers continue to use
/// the v2 entry point, so full-row behavior is selected only here rather than
/// inferred from optional fields.
pub(crate) fn merge_topic_doc_v3(
    connection: &mut Connection,
    document: &TopicDoc,
) -> Result<MergeReport, NotesError> {
    if document.root.format_version < 3 {
        return Err(
            "A v3 Notes merge requires the explicit v3 document envelope."
                .to_string()
                .into(),
        );
    }
    if document.root.plugin.is_none() && document.root.root_readonly.is_none() {
        return Err(
            "An ordinary v3 Notes root requires the root_readonly field."
                .to_string()
                .into(),
        );
    }
    merge_topic_doc_with_cleanup_mode(connection, document, None, None, true)
}

pub(crate) fn merge_topic_doc_with_cleanup(
    connection: &mut Connection,
    document: &TopicDoc,
    cleanup: Option<MergeCleanupIntent<'_>>,
    synchronized_hash: Option<&str>,
) -> Result<MergeReport, NotesError> {
    if document.root.format_version >= 3 || topic_document_has_v3_fields(document) {
        return Err("A v3 Notes document must use the explicit v3 merge path."
            .to_string()
            .into());
    }
    merge_topic_doc_with_cleanup_mode(connection, document, cleanup, synchronized_hash, false)
}

fn topic_document_has_v3_fields(document: &TopicDoc) -> bool {
    document.root.plugin.is_some()
        || document.root.plugin_children.is_some()
        || document.root.root_readonly.is_some()
        || !document.root.collapsed_groups.is_empty()
        || document.nodes.iter().any(topic_node_has_plugin_meta)
        || document.root.root_collapsed
        || document
            .nodes
            .iter()
            .any(topic_node_has_collapse_or_readonly)
}

fn topic_node_has_collapse_or_readonly(node: &TopicNode) -> bool {
    node.collapsed
        || node.readonly.is_some()
        || node
            .children
            .iter()
            .any(topic_node_has_collapse_or_readonly)
}

fn merge_topic_doc_with_cleanup_mode(
    connection: &mut Connection,
    document: &TopicDoc,
    cleanup: Option<MergeCleanupIntent<'_>>,
    synchronized_hash: Option<&str>,
    full_row: bool,
) -> Result<MergeReport, NotesError> {
    let ownership_ids = topic_sync_ownership_ids(document);
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start the Notes topic merge: {error}"))?;
    let plugin_storage = transaction_has_plugin_storage(&transaction)?;
    if full_row && !plugin_storage {
        return Err("A v3 Notes merge requires plugin storage columns."
            .to_string()
            .into());
    }
    validate_full_row_ownership(&transaction, document, false, full_row)?;
    let ownership_before = load_sync_ownership(&transaction, &ownership_ids)?;
    observe_topic_hlc_evidence(document)?;

    let mut report = MergeReport::default();
    let mut rebuilt_ids = BTreeSet::new();
    let mut moved_hlcs = BTreeMap::new();
    let mut incoming_ids = BTreeSet::from([document.id.clone()]);
    // A5: a hand-written topic file whose root has no `root_hlc` and no local row
    // is adopted with a fresh HLC. Without this the root never lands and the
    // exporter treats it as a topic pending removal (a RemoveTopic retry loop).
    let root_hlc = if document.root.hlc.is_empty() && !node_exists(&transaction, &document.id)? {
        report.needs_write_back = true;
        hlc::now(&transaction)?
    } else {
        document.root.hlc.clone()
    };
    let root = RemoteNode {
        id: document.id.clone(),
        parent_id: None,
        sort_key: document.sort_key,
        title: document.root.title.clone(),
        note: document.root.note.clone(),
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
        hlc: root_hlc,
        attachment: None,
        is_collapsed: document.root.root_collapsed,
        is_readonly: if full_row && document.root.plugin.is_none() {
            Some(document.root.root_readonly.unwrap_or(false))
        } else {
            None
        },
        plugin_state: (!document.root.collapsed_groups.is_empty()
            || document.root.plugin.is_some())
        .then(|| serde_json::to_string(&document.root.collapsed_groups).expect("groups serialize")),
        plugin_meta: None,
        full_row,
    };
    let _ = apply_remote_node(
        &transaction,
        &root,
        &mut report,
        &mut rebuilt_ids,
        &mut moved_hlcs,
        plugin_storage,
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
        // A5: a bullet with no yid, or one whose fabricated yid has no local row
        // and no usable HLC, is a fresh external input. Issue a new UUID + HLC and
        // keep its content instead of dropping it (which would erase it on the next
        // write-back).
        let (id, remote_hlc) = match &parsed.id {
            Some(id) if !parsed.hlc.is_empty() || node_exists(&transaction, id)? => {
                (id.clone(), parsed.hlc.clone())
            }
            _ => {
                report.new_ids_assigned += 1;
                report.needs_write_back = true;
                (Uuid::new_v4().to_string(), hlc::now(&transaction)?)
            }
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
            full_row,
        )?;
        apply_remote_node(
            &transaction,
            &remote,
            &mut report,
            &mut rebuilt_ids,
            &mut moved_hlcs,
            plugin_storage,
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
    park_overdeep_subtrees(&transaction, &document.id, &mut report, &mut rebuilt_ids)?;
    repair_affected_tree_integrity(&transaction, &incoming_ids, &mut report, &mut rebuilt_ids)?;
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
    mark_sync_ownership_changes(
        &transaction,
        &ownership_before,
        &load_sync_ownership(&transaction, &ownership_ids)?,
        MergeSource::Topic(&document.id),
    )?;
    if report.applied != 0 && ownership_before.contains_key(&document.id) {
        mark_dirty(&transaction, &document.id)?;
    }
    if report.needs_write_back {
        mark_dirty(&transaction, &document.id)?;
    }
    transaction
        .execute(
            "UPDATE sync_topics SET quarantined = 0 WHERE topic_id = ?1",
            [&document.id],
        )
        .map_err(|error| format!("Could not clear merged Notes quarantine: {error}"))?;
    if let Some(hash) = synchronized_hash {
        transaction
            .execute(
                "UPDATE sync_topics SET exported_hash = ?1, \
                        applied_max_hlc = max(applied_max_hlc, ?2), quarantined = 0 \
                 WHERE topic_id = ?3",
                params![hash, document.max_hlc, document.id],
            )
            .map_err(|error| format!("Could not record a synchronized Notes file hash: {error}"))?;
    }
    if let Some(cleanup) = cleanup {
        transaction
            .execute(
                "INSERT INTO sync_topics(topic_id, file_name, exported_hash, quarantined) \
                 VALUES (?1, ?2, ?3, 1) \
                 ON CONFLICT(topic_id) DO UPDATE SET \
                   file_name = excluded.file_name, \
                   exported_hash = excluded.exported_hash, quarantined = 1",
                params![
                    cleanup.marker_topic_id,
                    cleanup.file_name,
                    cleanup.source_hash
                ],
            )
            .map_err(|error| format!("Could not record Notes bounced-copy cleanup: {error}"))?;
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
    if document.format_version >= 3
        || document
            .nodes
            .iter()
            .any(topic_node_has_collapse_or_readonly)
    {
        return Err(
            "A v3 Notes trash document must use the explicit v3 merge path."
                .to_string()
                .into(),
        );
    }
    merge_trash_doc_with_hash_mode(connection, document, None, false)
}

/// Explicit dormant v3 trash merge. Plugin-owned rows remain invalid in trash.
pub(crate) fn merge_trash_doc_v3(
    connection: &mut Connection,
    document: &TrashDoc,
) -> Result<MergeReport, NotesError> {
    if document.format_version < 3 {
        return Err(
            "A v3 Notes trash merge requires the explicit v3 document envelope."
                .to_string()
                .into(),
        );
    }
    merge_trash_doc_with_hash_mode(connection, document, None, true)
}

pub(crate) fn merge_trash_doc_with_hash(
    connection: &mut Connection,
    document: &TrashDoc,
    synchronized_hash: Option<&str>,
) -> Result<MergeReport, NotesError> {
    if document.format_version >= 3
        || document
            .nodes
            .iter()
            .any(topic_node_has_collapse_or_readonly)
    {
        return Err(
            "A v3 Notes trash document must use the explicit v3 merge path."
                .to_string()
                .into(),
        );
    }
    merge_trash_doc_with_hash_mode(connection, document, synchronized_hash, false)
}

fn merge_trash_doc_with_hash_mode(
    connection: &mut Connection,
    document: &TrashDoc,
    synchronized_hash: Option<&str>,
    full_row: bool,
) -> Result<MergeReport, NotesError> {
    let ownership_ids = trash_sync_ownership_ids(document);
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start the Notes trash merge: {error}"))?;
    let plugin_storage = transaction_has_plugin_storage(&transaction)?;
    if full_row && !plugin_storage {
        return Err("A v3 Notes merge requires plugin storage columns."
            .to_string()
            .into());
    }
    validate_full_row_ownership(&transaction, document, true, full_row)?;
    let ownership_before = load_sync_ownership(&transaction, &ownership_ids)?;
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
        // A5: mirror the topic path — an unseen/fabricated yid with no usable HLC
        // becomes a fresh external input rather than being dropped.
        let (id, remote_hlc) = match &parsed.id {
            Some(id) if !parsed.hlc.is_empty() || node_exists(&transaction, id)? => {
                (id.clone(), parsed.hlc.clone())
            }
            _ => {
                report.new_ids_assigned += 1;
                report.needs_write_back = true;
                (Uuid::new_v4().to_string(), hlc::now(&transaction)?)
            }
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
            full_row,
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
            plugin_storage,
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
    repair_affected_tree_integrity(&transaction, &affected_ids, &mut report, &mut rebuilt_ids)?;
    let today = SystemLocalTodayProvider.local_today(&transaction)?;
    rebuild_derived_for_nodes_at(&transaction, &rebuilt_ids, today)?;
    mark_sync_ownership_changes(
        &transaction,
        &ownership_before,
        &load_sync_ownership(&transaction, &ownership_ids)?,
        MergeSource::Trash,
    )?;
    if report.needs_write_back {
        mark_dirty(&transaction, TRASH_TOPIC_ID)?;
        let mut write_back_ids = incoming_ids;
        write_back_ids.extend(document.purged.iter().map(|tombstone| tombstone.id.clone()));
        for id in write_back_ids {
            mark_dirty(&transaction, &id)?;
        }
    }
    if let Some(hash) = synchronized_hash {
        transaction
            .execute(
                "UPDATE sync_topics SET exported_hash = ?1, \
                        applied_max_hlc = max(applied_max_hlc, ?2), quarantined = 0 \
                 WHERE topic_id = ?3",
                params![hash, document.max_hlc, TRASH_TOPIC_ID],
            )
            .map_err(|error| format!("Could not record synchronized Notes trash hash: {error}"))?;
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

fn repair_affected_tree_integrity(
    transaction: &Transaction<'_>,
    affected_ids: &BTreeSet<String>,
    report: &mut MergeReport,
    rebuilt_ids: &mut BTreeSet<String>,
) -> Result<(), NotesError> {
    if affected_ids.is_empty() {
        return Ok(());
    }
    let affected_ids = affected_ids.iter().collect::<Vec<_>>();
    let mut invalid_active_ids = BTreeSet::new();
    let mut invalid_archived_ids = BTreeMap::new();
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
             ), \
             candidate_archive_roots(id) AS (\
               SELECT DISTINCT node.archive_root_id \
               FROM notes_nodes node \
               JOIN affected ON affected.id = node.id \
               WHERE node.deleted_at IS NULL \
                 AND node.archived_at IS NOT NULL \
                 AND node.archive_root_id IS NOT NULL\
             ), \
             valid_archived(id, archive_root_id) AS (\
               SELECT root.id, root.id \
               FROM notes_nodes root \
               JOIN candidate_archive_roots candidate ON candidate.id = root.id \
               WHERE root.deleted_at IS NULL \
                 AND root.archived_at IS NOT NULL \
                 AND root.parent_id IS NULL \
                 AND root.archive_root_id = root.id \
               UNION \
               SELECT child.id, parent.archive_root_id \
               FROM notes_nodes child \
               JOIN valid_archived parent ON child.parent_id = parent.id \
               WHERE child.deleted_at IS NULL \
                 AND child.archived_at IS NOT NULL \
                 AND child.archive_root_id = parent.archive_root_id\
             ), \
             invalid_archived(id, parent_id) AS (\
               SELECT node.id, node.parent_id \
               FROM notes_nodes node \
               JOIN affected ON affected.id = node.id \
               WHERE node.deleted_at IS NULL \
                 AND node.archived_at IS NOT NULL \
                 AND NOT EXISTS (\
                   SELECT 1 FROM valid_archived valid WHERE valid.id = node.id\
                 )\
             ) \
             SELECT node.id, 0, NULL, 0 \
             FROM notes_nodes node \
             JOIN affected ON affected.id = node.id \
             LEFT JOIN notes_nodes parent ON parent.id = node.parent_id \
             WHERE node.deleted_at IS NULL AND node.archived_at IS NULL \
               AND node.parent_id IS NOT NULL \
               AND (parent.id IS NULL OR parent.deleted_at IS NOT NULL \
                    OR parent.archived_at IS NOT NULL) \
             UNION ALL \
             SELECT invalid.id, 1, invalid.parent_id, \
                    EXISTS(\
                      SELECT 1 FROM notes_nodes parent \
                      WHERE parent.id = invalid.parent_id \
                        AND parent.deleted_at IS NULL \
                        AND parent.archived_at IS NULL\
                    ) \
             FROM invalid_archived invalid \
             ORDER BY 1, 2"
        );
        let mut statement = transaction
            .prepare(&sql)
            .map_err(|error| format!("Could not prepare affected Notes tree integrity: {error}"))?;
        let rows = statement
            .query_map(
                rusqlite::params_from_iter(seed_ids.iter().map(|id| id.as_str())),
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, bool>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, bool>(3)?,
                    ))
                },
            )
            .map_err(|error| format!("Could not inspect affected Notes tree integrity: {error}"))?;
        let repairs = rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
            NotesError::from(format!(
                "Could not read affected Notes tree integrity: {error}"
            ))
        })?;
        for (node_id, is_archived, parent_id, parent_is_active) in repairs {
            if is_archived {
                invalid_archived_ids.insert(node_id, (parent_id, parent_is_active));
            } else {
                invalid_active_ids.insert(node_id);
            }
        }
    }
    let mut park_ids = invalid_active_ids;
    let mut reactivate_ids = BTreeSet::new();
    for (node_id, (parent_id, parent_is_active)) in &invalid_archived_ids {
        let parent_will_be_active = match parent_id {
            None => true,
            Some(parent_id) => *parent_is_active || invalid_archived_ids.contains_key(parent_id),
        };
        if parent_will_be_active {
            reactivate_ids.insert(node_id.clone());
        } else {
            park_ids.insert(node_id.clone());
        }
    }
    for node_id in &reactivate_ids {
        recover_archived_survivor(transaction, node_id)?;
    }
    for node_id in &park_ids {
        park_orphan(transaction, node_id)?;
    }
    for node_id in reactivate_ids.into_iter().chain(park_ids) {
        rebuilt_ids.insert(node_id);
        report.needs_write_back = true;
    }
    Ok(())
}

#[derive(Debug, Clone)]
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
    is_collapsed: bool,
    is_readonly: Option<bool>,
    plugin_state: Option<String>,
    plugin_meta: Option<String>,
    full_row: bool,
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

fn transaction_has_plugin_storage(transaction: &Transaction<'_>) -> Result<bool, NotesError> {
    #[cfg(test)]
    PLUGIN_STORAGE_INTROSPECTION_COUNT.with(|count| count.set(count.get() + 1));
    transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('notes_nodes') WHERE name = 'is_readonly')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not inspect Notes plugin storage: {error}").into())
}

#[cfg(test)]
thread_local! {
    static PLUGIN_STORAGE_INTROSPECTION_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static PLUGIN_OWNERSHIP_QUERY_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn reset_plugin_storage_introspection_count() {
    PLUGIN_STORAGE_INTROSPECTION_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
fn plugin_storage_introspection_count() -> usize {
    PLUGIN_STORAGE_INTROSPECTION_COUNT.with(std::cell::Cell::get)
}

#[cfg(test)]
fn reset_plugin_ownership_query_count() {
    PLUGIN_OWNERSHIP_QUERY_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
fn plugin_ownership_query_count() -> usize {
    PLUGIN_OWNERSHIP_QUERY_COUNT.with(std::cell::Cell::get)
}

fn validate_full_row_ownership(
    transaction: &Transaction<'_>,
    document: &impl SyncDocumentNodes,
    trash: bool,
    full_row: bool,
) -> Result<(), NotesError> {
    if !full_row {
        return Ok(());
    }
    let is_github_topic = !trash
        && document.document_id() == GITHUB_NOTIFICATIONS_ROOT_ID
        && document.claims_github_identity();
    if trash && document.contains_plugin_meta() {
        return Err("Github-owned rows cannot be merged into Notes trash."
            .to_string()
            .into());
    }
    let mut node_ids = document.node_ids();
    node_ids.sort();
    node_ids.dedup();
    for node_id in &node_ids {
        if node_id == GITHUB_NOTIFICATIONS_ROOT_ID
            && (!is_github_topic || node_id != document.document_id())
        {
            return Err(
                "The Github Notifications root may only be the canonical topic root."
                    .to_string()
                    .into(),
            );
        }
    }
    if trash || !is_github_topic {
        for chunk in node_ids.chunks(AFFECTED_ID_QUERY_CHUNK_SIZE) {
            #[cfg(test)]
            PLUGIN_OWNERSHIP_QUERY_COUNT.with(|count| count.set(count.get() + 1));
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "SELECT 1 FROM notes_nodes \
                 WHERE plugin_meta IS NOT NULL AND id IN ({placeholders}) LIMIT 1"
            );
            let claimed = transaction
                .query_row(&sql, params_from_iter(chunk.iter()), |_| Ok(()))
                .optional()
                .map_err(|error| format!("Could not inspect Notes plugin ownership: {error}"))?
                .is_some();
            if !claimed {
                continue;
            }
            return Err(
                "An ordinary Notes document cannot claim a plugin-owned row."
                    .to_string()
                    .into(),
            );
        }
    }
    if !trash && !is_github_topic && document.contains_plugin_meta() {
        return Err(
            "An ordinary Notes document cannot contain plugin-owned rows."
                .to_string()
                .into(),
        );
    }
    Ok(())
}

trait SyncDocumentNodes {
    fn document_id(&self) -> &str;
    fn node_ids(&self) -> Vec<String>;
    fn contains_plugin_meta(&self) -> bool;
    fn claims_github_identity(&self) -> bool;
}

impl SyncDocumentNodes for TopicDoc {
    fn document_id(&self) -> &str {
        &self.id
    }

    fn node_ids(&self) -> Vec<String> {
        let mut ids = vec![self.id.clone()];
        let mut stack = self.nodes.iter().collect::<Vec<_>>();
        while let Some(node) = stack.pop() {
            if let Some(id) = &node.id {
                ids.push(id.clone());
            }
            stack.extend(node.children.iter());
        }
        ids
    }

    fn contains_plugin_meta(&self) -> bool {
        self.nodes.iter().any(topic_node_has_plugin_meta)
    }

    fn claims_github_identity(&self) -> bool {
        self.root.title == GITHUB_NOTIFICATIONS_TITLE
            && self.root.plugin.as_deref() == Some(GITHUB_NOTIFICATIONS_PLUGIN_ID)
            && self.root.plugin_children.as_deref() == Some("hybrid")
    }
}

impl SyncDocumentNodes for TrashDoc {
    fn document_id(&self) -> &str {
        ""
    }

    fn node_ids(&self) -> Vec<String> {
        let mut ids = Vec::new();
        let mut stack = self.nodes.iter().collect::<Vec<_>>();
        while let Some(node) = stack.pop() {
            if let Some(id) = &node.id {
                ids.push(id.clone());
            }
            stack.extend(node.children.iter());
        }
        ids
    }

    fn contains_plugin_meta(&self) -> bool {
        self.nodes.iter().any(topic_node_has_plugin_meta)
    }

    fn claims_github_identity(&self) -> bool {
        false
    }
}

fn remote_topic_node(
    transaction: &Transaction<'_>,
    parsed: &TopicNode,
    id: &str,
    remote_hlc: &str,
    parent_id: Option<&str>,
    archived_at: Option<&str>,
    archive_root_id: &str,
    full_row: bool,
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
    let plugin_meta = parsed.plugin_meta.as_ref().map(|meta| {
        let metadata = match meta {
            crate::notes::sync::topic_file::TopicPluginMeta::GithubDate { date_key } => {
                GithubNotificationsPluginMeta::Date {
                    date_key: date_key.clone(),
                }
            }
        crate::notes::sync::topic_file::TopicPluginMeta::GithubNotification {
            notification_key,
            notification_type,
            url,
            updated_at,
            unread,
            } => GithubNotificationsPluginMeta::Notification {
                notification_key: notification_key.clone(),
                notification_type: notification_type.clone(),
                url: url.clone(),
                updated_at: updated_at.clone(),
                unread: *unread,
            },
        };
        serialize_github_plugin_meta_storage(&metadata)
            .expect("plugin metadata serializes for database storage")
    });
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
        is_collapsed: parsed.collapsed,
        is_readonly: if full_row {
            Some(parsed.readonly.unwrap_or(false)).filter(|_| parsed.plugin_meta.is_none())
        } else {
            parsed.readonly
        },
        plugin_state: None,
        plugin_meta,
        full_row,
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
                if path.len() > MAX_NOTES_EXPORT_DEPTH {
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

/// A2.3: a merge can push a live subtree past the export depth cap (e.g. a file
/// re-parents a node deep while its untouched descendants stay attached). Park
/// the shallowest offending subtree root under the recovery topic (reusing the
/// cycle-park infrastructure). Selecting the minimum (depth, id) keeps the choice
/// deterministic across devices.
///
// ponytail: only the merged topic's own subtree is rescanned here; if a parked
// subtree is itself deeper than the cap it is caught by the recovery topic's
// export pre-render cap instead of a second pass.
fn park_overdeep_subtrees(
    transaction: &Transaction<'_>,
    topic_id: &str,
    report: &mut MergeReport,
    rebuilt_ids: &mut BTreeSet<String>,
) -> Result<(), NotesError> {
    let max_depth = i64::try_from(MAX_NOTES_EXPORT_DEPTH).unwrap_or(i64::MAX);
    // R6: collect every minimal over-deep subtree root in ONE recursive pass
    // instead of re-scanning the whole topic after each park (which was O(n^2)
    // under a single write lock — an adversarial file could freeze the UI for
    // minutes). The shallowest offender on every root-to-leaf path sits at
    // exactly `max_depth + 1` (the recursion stops there), and every deeper node
    // is a descendant of one of them, so parking this set relocates all
    // over-deep nodes. These roots are the same depth and therefore disjoint
    // subtrees, so parking order does not change the result; id order keeps the
    // choice deterministic across devices (the old loop's (depth, id) rule).
    let candidates = {
        let mut statement = transaction
            .prepare(
                "WITH RECURSIVE depths(id, depth) AS (\
                   SELECT ?1, 1 \
                   UNION ALL \
                   SELECT child.id, depths.depth + 1 \
                   FROM notes_nodes child JOIN depths ON child.parent_id = depths.id \
                   WHERE child.deleted_at IS NULL AND depths.depth <= ?2\
                 ) \
                 SELECT id FROM depths WHERE depth = ?2 + 1 ORDER BY id",
            )
            .map_err(|error| format!("Could not prepare merged Notes nesting depth: {error}"))?;
        let rows = statement
            .query_map(params![topic_id, max_depth], |row| row.get::<_, String>(0))
            .map_err(|error| format!("Could not inspect merged Notes nesting depth: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
            NotesError::from(format!(
                "Could not read merged Notes nesting depth: {error}"
            ))
        })?
    };
    for candidate in candidates {
        park_orphan(transaction, &candidate)?;
        rebuilt_ids.insert(candidate);
        report.parked_cycles += 1;
        report.needs_write_back = true;
    }
    Ok(())
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

pub(crate) fn ensure_recovery_topic(transaction: &Transaction<'_>) -> Result<String, NotesError> {
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

/// Compares the local node against the file's node for equal-HLC adoption.
/// Legacy v2 echoes retain the historical content-only comparison; explicit v3
/// documents compare the complete row, including collapse, readonly, and
/// plugin storage fields, so a remote winner cannot silently lose state.
fn local_content_differs(
    transaction: &Transaction<'_>,
    remote: &RemoteNode,
) -> Result<bool, NotesError> {
    let (title, note, offset, kind, starred, completed) = transaction
        .query_row(
            "SELECT title, note, image_offset_utf16, node_kind, is_starred, \
                    completed_at IS NOT NULL \
             FROM notes_nodes WHERE id = ?1",
            [&remote.id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)? != 0,
                    row.get::<_, bool>(5)?,
                ))
            },
        )
        .map_err(|error| format!("Could not inspect local Notes content: {error}"))?;
    // R3: a topic root has no image slot in the file format — build_topic_doc
    // flattens every root to text (kind Text, no attachment, offset 0), so a
    // legacy image root exports a lossy text echo. Comparing kind/attachment/
    // offset for a root would read that synthetic flattening as a hand edit and
    // fire A4 adoption, demoting the root to text and deleting its attachment.
    // Those three fields are artifacts of the root representation, not edit
    // evidence, so they are excluded for roots; title/note/starred/completed
    // still detect a genuine root hand edit.
    let is_root = remote.parent_id.is_none();
    if title != remote.title
        || note != remote.note
        || starred != remote.starred
        || completed != remote.completed_at.is_some()
        || (!is_root && (offset != remote.image_offset_utf16 || kind != remote.node_kind.as_str()))
    {
        return Ok(true);
    }
    if !is_root {
        let local_attachment = transaction
            .query_row(
                "SELECT content_hash, original_name, display_width \
                 FROM notes_attachments WHERE node_id = ?1",
                [&remote.id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("Could not inspect local Notes attachment: {error}"))?;
        let attachment_differs = match (&remote.attachment, local_attachment) {
            (None, None) => false,
            (Some(attachment), Some((hash, name, width))) => {
                let expected_name = crate::notes::markdown_import::decode_canonical_original_name(
                    &attachment.encoded_original_name,
                )?;
                attachment.content_hash != hash
                    || expected_name != name
                    || attachment.display_width.unwrap_or(0) != width
            }
            _ => true,
        };
        if attachment_differs {
            return Ok(true);
        }
    }
    if !remote.full_row {
        return Ok(false);
    }
    let (collapsed, readonly, plugin_state, plugin_meta) = transaction
        .query_row(
            "SELECT is_collapsed, is_readonly, plugin_state, plugin_meta \
             FROM notes_nodes WHERE id = ?1",
            [&remote.id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)? != 0,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .map_err(|error| format!("Could not inspect local Notes plugin row: {error}"))?;
    let local_readonly = readonly.map(|value| value != 0);
    let expected_readonly =
        if remote.id == GITHUB_NOTIFICATIONS_ROOT_ID || remote.plugin_meta.is_some() {
            None
        } else {
            Some(remote.is_readonly.unwrap_or(false))
        };
    Ok(collapsed != remote.is_collapsed
        || local_readonly != expected_readonly
        || plugin_state != remote.plugin_state
        || plugin_meta != remote.plugin_meta)
}

fn apply_remote_node(
    transaction: &Transaction<'_>,
    remote: &RemoteNode,
    report: &mut MergeReport,
    rebuilt_ids: &mut BTreeSet<String>,
    moved_hlcs: &mut BTreeMap<String, String>,
    plugin_storage: bool,
) -> Result<bool, NotesError> {
    if remote.full_row && notification_update_is_stale(transaction, remote)? {
        report.needs_write_back = true;
        return Ok(false);
    }
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
    // A4: an equal HLC normally means identical content (an echo of our own
    // write). A hand edit that kept the yid/t but changed the text also arrives
    // with an equal HLC; adopt the file's content under a fresh HLC so the local
    // truth follows the file and the edit propagates. Identical content still
    // skips, keeping the merge idempotent for canonical documents.
    let adopted;
    let remote = match local.as_ref() {
        Some((local_hlc, _)) if remote.hlc == *local_hlc => {
            if !local_content_differs(transaction, remote)? {
                return Ok(false);
            }
            report.needs_write_back = true;
            adopted = RemoteNode {
                hlc: hlc::now(transaction)?,
                ..remote.clone()
            };
            &adopted
        }
        _ => remote,
    };
    match local.as_ref() {
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
            update_remote_node(transaction, remote, plugin_storage)?;
        }
        None => {
            if attachment_id_exists(transaction, &remote.id)? {
                return Err("A merged Notes node ID collides with an attachment."
                    .to_string()
                    .into());
            }
            insert_remote_node(transaction, remote, plugin_storage)?;
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

fn notification_update_is_stale(
    transaction: &Transaction<'_>,
    remote: &RemoteNode,
) -> Result<bool, NotesError> {
    let Some(remote_json) = remote.plugin_meta.as_deref() else {
        return Ok(false);
    };
    let Ok(GithubNotificationsPluginMeta::Notification {
        updated_at: remote_updated_at,
        unread: remote_unread,
        ..
    }) = parse_github_plugin_meta_storage(remote_json)
    else {
        return Ok(false);
    };
    let local_json: Option<String> = transaction
        .query_row(
            "SELECT plugin_meta FROM notes_nodes WHERE id = ?1",
            [&remote.id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| format!("Could not inspect local notification metadata: {error}"))?
        .flatten();
    let Some(local_json) = local_json else {
        return Ok(false);
    };
    let Ok(GithubNotificationsPluginMeta::Notification {
        updated_at: local_updated_at,
        unread: local_unread,
        ..
    }) = parse_github_plugin_meta_storage(&local_json)
    else {
        return Ok(false);
    };
    match compare_github_notification_timestamps(&remote_updated_at, &local_updated_at) {
        Some(std::cmp::Ordering::Less) => Ok(true),
        Some(std::cmp::Ordering::Equal) => Ok(!local_unread && remote_unread),
        Some(std::cmp::Ordering::Greater) => Ok(false),
        None => Ok(remote_updated_at < local_updated_at
            || (remote_updated_at == local_updated_at && !local_unread && remote_unread)),
    }
}

fn insert_remote_node(
    transaction: &Transaction<'_>,
    remote: &RemoteNode,
    plugin_storage: bool,
) -> Result<(), NotesError> {
    let timestamp = timestamp_for_hlc(transaction, &remote.hlc)?;
    if remote.full_row && plugin_storage {
        return transaction
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, note, image_offset_utf16, layout_mode, \
                   is_collapsed, is_starred, completed_at, created_at, updated_at, deleted_at, \
                   deleted_batch_id, archived_at, archive_root_id, node_kind, hlc, \
                   is_readonly, plugin_state, plugin_meta\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'bullets', ?7, ?8, ?9, ?10, ?10, ?11, \
                           ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
                params![
                    remote.id,
                    remote.parent_id,
                    remote.sort_key,
                    remote.title,
                    remote.note,
                    remote.image_offset_utf16,
                    i64::from(remote.is_collapsed),
                    i64::from(remote.starred),
                    remote.completed_at,
                    timestamp,
                    remote.deleted_at,
                    remote.deleted_batch_id,
                    remote.archived_at,
                    remote.archive_root_id,
                    remote.node_kind.as_str(),
                    remote.hlc,
                    remote.is_readonly.map(i64::from),
                    remote.plugin_state,
                    remote.plugin_meta,
                ],
            )
            .map(|_| ())
            .map_err(|error| format!("Could not insert a merged Notes v3 node: {error}").into());
    }
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
    plugin_storage: bool,
) -> Result<(), NotesError> {
    let timestamp = timestamp_for_hlc(transaction, &remote.hlc)?;
    if remote.full_row && plugin_storage {
        return transaction
            .execute(
                "UPDATE notes_nodes SET \
                   parent_id = ?1, sort_key = ?2, title = ?3, note = ?4, image_offset_utf16 = ?5, \
                   layout_mode = 'bullets', is_collapsed = ?6, is_starred = ?7, completed_at = ?8, \
                   updated_at = ?9, deleted_at = ?10, deleted_batch_id = ?11, archived_at = ?12, \
                   archive_root_id = ?13, node_kind = ?14, hlc = ?15, is_readonly = ?16, \
                   plugin_state = ?17, plugin_meta = ?18 WHERE id = ?19",
                params![
                    remote.parent_id,
                    remote.sort_key,
                    remote.title,
                    remote.note,
                    remote.image_offset_utf16,
                    i64::from(remote.is_collapsed),
                    i64::from(remote.starred),
                    remote.completed_at,
                    timestamp,
                    remote.deleted_at,
                    remote.deleted_batch_id,
                    remote.archived_at,
                    remote.archive_root_id,
                    remote.node_kind.as_str(),
                    remote.hlc,
                    remote.is_readonly.map(i64::from),
                    remote.plugin_state,
                    remote.plugin_meta,
                    remote.id,
                ],
            )
            .map(|_| ())
            .map_err(|error| format!("Could not update a merged Notes v3 node: {error}").into());
    }
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
        "is_collapsed": remote.is_collapsed,
        "is_readonly": remote.is_readonly,
        "plugin_state": remote.plugin_state,
        "plugin_meta": remote.plugin_meta,
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
    use crate::notes::sync::exporter::TRASH_TOPIC_ID;
    use crate::notes::sync::topic_file::{
        render_topic_doc, PurgedTombstone, TopicAttachment, TopicContent, TopicFile, TopicNode,
        TopicPluginMeta, TopicRoot, TrashDoc,
    };
    use crate::notes::sync::topic_parser::{parse_topic_file, TopicParseOutcome};
    use crate::notes::types::NotesWorkspaceScope;
    use rusqlite::{params, TransactionBehavior};
    use std::time::{Duration, Instant};

    const TOPIC_ID: &str = "11111111-1111-4111-8111-111111111111";
    const NODE_ID: &str = "22222222-2222-4222-8222-222222222222";
    const SECOND_TOPIC_ID: &str = "33333333-3333-4333-8333-333333333333";
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

    fn v3_test_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open v3 test database");
        crate::notes::schema::install_notes_sql_functions(&connection)
            .expect("install v3 Notes SQL functions");
        connection
            .execute_batch(crate::notes::schema::V3_SCHEMA_SQL)
            .expect("create v3 Notes schema");
        connection
            .execute(
                "INSERT INTO notes_metadata(id,vault_generation) VALUES (1,?1)",
                ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
            )
            .expect("seed v3 Notes metadata");
        connection
            .execute(
                "INSERT INTO sync_meta(id,device_id,vault_uuid) VALUES (1,?1,?2)",
                params![
                    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
                ],
            )
            .expect("seed v3 sync metadata");
        history::install_session_history(&connection).expect("install v3 session history");
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
            collapsed: false,
            readonly: None,
            plugin_meta: None,
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
                format_version: 2,
                title: "Topic".to_string(),
                note: String::new(),
                hlc: ROOT_HLC.to_string(),
                starred: false,
                completed_at: None,
                archived_at: None,
                root_collapsed: false,
                root_readonly: None,
                plugin: None,
                plugin_children: None,
                collapsed_groups: Vec::new(),
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

    #[test]
    fn production_v2_cleanup_entry_rejects_v3_before_any_write() {
        let mut connection = test_connection();
        let mut document = topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "child")]);
        document.root.format_version = 3;
        document.root.root_readonly = Some(false);
        let before_nodes = sync_state(&connection);
        let before_dirty = dirty_ids(&connection);
        let before_topics = connection
            .query_row("SELECT COUNT(*) FROM sync_topics", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count sync topics");

        assert!(merge_topic_doc_with_cleanup(&mut connection, &document, None, None).is_err());
        assert_eq!(sync_state(&connection), before_nodes);
        assert_eq!(dirty_ids(&connection), before_dirty);
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM sync_topics", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("count sync topics after rejection"),
            before_topics
        );
    }

    #[test]
    fn production_v2_trash_entry_rejects_v3_before_any_write() {
        let mut connection = test_connection();
        let document = TrashDoc {
            format_version: 3,
            max_hlc: NODE_HLC.to_string(),
            purged: Vec::new(),
            nodes: vec![text_node(Some(NODE_ID), NODE_HLC, "deleted child")],
        };
        let before_nodes = sync_state(&connection);
        let before_dirty = dirty_ids(&connection);
        let before_topics = connection
            .query_row("SELECT COUNT(*) FROM sync_topics", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count sync topics");

        assert!(merge_trash_doc_with_hash(&mut connection, &document, None).is_err());
        assert_eq!(sync_state(&connection), before_nodes);
        assert_eq!(dirty_ids(&connection), before_dirty);
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM sync_topics", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("count sync topics after rejection"),
            before_topics
        );
    }

    #[test]
    fn v3_winning_remote_update_applies_full_row_collapse_and_readonly_state() {
        let mut connection = v3_test_connection();
        connection
            .execute(
                "INSERT INTO notes_nodes(id,parent_id,sort_key,title,note,is_collapsed,is_readonly,created_at,updated_at,hlc) \
                 VALUES (?1,NULL,1024,'old root','',0,0,'2026-07-21T00:00:00Z','2026-07-21T00:00:00Z',?2), \
                        (?3,?1,1024,'old parent','',0,0,'2026-07-21T00:00:00Z','2026-07-21T00:00:00Z',?2), \
                        (?4,?3,1024,'old child','',0,0,'2026-07-21T00:00:00Z','2026-07-21T00:00:00Z',?5)",
                params![TOPIC_ID, ROOT_HLC, SECOND_TOPIC_ID, NODE_ID, NODE_HLC],
            )
            .expect("insert v3 merge rows");
        let mut child = text_node(Some(NODE_ID), HIGH_HLC, "new child");
        child.collapsed = true;
        child.readonly = Some(true);
        child.completed = true;
        child.sort_key = 2 * SORT_KEY_STEP;
        let mut document = topic_with(vec![child]);
        document.root.format_version = 3;
        document.root.title = "new root".to_string();
        document.root.root_collapsed = true;
        document.root.root_readonly = Some(false);
        document.root.completed_at = Some("2026-07-23T00:00:00Z".to_string());
        document.max_hlc = HIGH_HLC.to_string();
        document.root.hlc = HIGH_HLC.to_string();
        reset_plugin_storage_introspection_count();
        merge_topic_doc_v3(&mut connection, &document).expect("merge v3 full row");
        assert!(plugin_storage_introspection_count() <= 1);
        let row = connection
            .query_row(
                "SELECT parent_id,sort_key,title,is_collapsed,is_readonly FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                    ))
                },
            )
            .expect("read v3 merged child");
        assert_eq!(row.0.as_deref(), Some(TOPIC_ID));
        assert_eq!(row.1, 2 * SORT_KEY_STEP);
        assert_eq!(row.2, "new child");
        assert_eq!(row.3, 1);
        assert_eq!(row.4, Some(1));
        assert!(connection
            .query_row(
                "SELECT completed_at IS NOT NULL FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get::<_, bool>(0),
            )
            .expect("read child completion"));
        let root_state = connection
            .query_row(
                "SELECT title,is_collapsed,is_readonly,completed_at IS NOT NULL FROM notes_nodes WHERE id = ?1",
                [TOPIC_ID],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, Option<i64>>(2)?, row.get::<_, bool>(3)?)),
            )
            .expect("read v3 merged root");
        assert_eq!(root_state, ("new root".to_string(), 1, Some(0), true));
    }

    #[test]
    fn v3_ownership_validation_queries_are_chunk_bounded() {
        let mut connection = v3_test_connection();
        let nodes = (0..1_000)
            .map(|index| {
                let id = format!("10000000-0000-4000-8000-{index:012x}");
                text_node(Some(&id), HIGH_HLC, "ordinary node")
            })
            .collect();
        let mut document = topic_with(nodes);
        document.root.format_version = 3;
        document.root.root_readonly = Some(false);
        document.root.hlc = HIGH_HLC.to_string();
        document.max_hlc = HIGH_HLC.to_string();
        reset_plugin_ownership_query_count();

        merge_topic_doc_v3(&mut connection, &document).expect("merge large ordinary v3 topic");

        assert!(
            plugin_ownership_query_count() <= 3,
            "ownership validation should query once per bounded parameter chunk"
        );
    }

    #[test]
    #[ignore = "release-only v3 merge performance contract"]
    fn v3_merge_performance_contract_covers_ordinary_github_and_trash() {
        let ordinary_nodes = (0..1_000)
            .map(|index| {
                let id = format!("10000000-0000-4000-8000-{index:012x}");
                text_node(Some(&id), HIGH_HLC, "ordinary performance node")
            })
            .collect();
        let mut ordinary = topic_with(ordinary_nodes);
        ordinary.root.format_version = 3;
        ordinary.root.root_readonly = Some(false);
        ordinary.root.hlc = HIGH_HLC.to_string();
        ordinary.max_hlc = HIGH_HLC.to_string();
        let mut ordinary_connection = v3_test_connection();
        reset_plugin_storage_introspection_count();
        reset_plugin_ownership_query_count();
        let ordinary_started = Instant::now();
        merge_topic_doc_v3(&mut ordinary_connection, &ordinary)
            .expect("merge ordinary v3 performance topic");
        let ordinary_elapsed = ordinary_started.elapsed();
        assert!(plugin_storage_introspection_count() <= 1);
        assert!(plugin_ownership_query_count() <= 3);

        let mut github = github_notification_document(true, "2026-07-21T10:00:00.000Z");
        github.nodes[0].children = (0..500)
            .map(|index| {
                let notification_id = format!("20000000-0000-4000-8000-{index:012x}");
                let user_id = format!("30000000-0000-4000-8000-{index:012x}");
                let mut notification =
                    text_node(Some(&notification_id), HIGH_HLC, "Github notification");
                notification.plugin_meta = Some(TopicPluginMeta::GithubNotification {
                    notification_key: format!(
                        "[\"github\",\"[\\\"https://api.github.com\\\",\\\"account-7\\\"]\",\"thread-{index}\"]"
                    ),
                    notification_type: "issue".to_string(),
                    url: format!("https://github.com/acme/yonalist/issues/{index}"),
                    updated_at: "2026-07-21T10:00:00.000Z".to_string(),
                    unread: true,
                });
                let mut user = text_node(Some(&user_id), HIGH_HLC, "user context");
                user.readonly = Some(false);
                notification.children = vec![user];
                notification
            })
            .collect();
        let mut github_connection = v3_test_connection();
        reset_plugin_storage_introspection_count();
        reset_plugin_ownership_query_count();
        let github_started = Instant::now();
        merge_topic_doc_v3(&mut github_connection, &github)
            .expect("merge Github hybrid v3 performance topic");
        let github_elapsed = github_started.elapsed();
        assert!(plugin_storage_introspection_count() <= 1);
        assert_eq!(plugin_ownership_query_count(), 0);

        let trash = TrashDoc {
            format_version: 3,
            max_hlc: HIGH_HLC.to_string(),
            purged: Vec::new(),
            nodes: (0..1_000)
                .map(|index| {
                    let id = format!("40000000-0000-4000-8000-{index:012x}");
                    text_node(Some(&id), HIGH_HLC, "trash performance node")
                })
                .collect(),
        };
        let mut trash_connection = v3_test_connection();
        reset_plugin_storage_introspection_count();
        reset_plugin_ownership_query_count();
        let trash_started = Instant::now();
        merge_trash_doc_v3(&mut trash_connection, &trash)
            .expect("merge v3 trash performance document");
        let trash_elapsed = trash_started.elapsed();
        assert!(plugin_storage_introspection_count() <= 1);
        assert!(plugin_ownership_query_count() <= 2);

        eprintln!(
            "v3 merge performance: ordinary 1k={ordinary_elapsed:?}, Github hybrid 1k={github_elapsed:?}, trash 1k={trash_elapsed:?}"
        );
        for (name, elapsed) in [
            ("ordinary", ordinary_elapsed),
            ("Github hybrid", github_elapsed),
            ("trash", trash_elapsed),
        ] {
            assert!(
                elapsed < Duration::from_secs(1),
                "{name} v3 1k merge took {elapsed:?}; personal-laptop gate is 1s"
            );
        }
    }

    #[test]
    fn v3_ordinary_documents_cannot_claim_github_owned_rows() {
        let mut connection = v3_test_connection();
        let mut document = topic_with(Vec::new());
        document.root.format_version = 3;
        document.id = GITHUB_NOTIFICATIONS_ROOT_ID.to_string();
        document.root.title = "Ordinary impostor".to_string();
        assert!(merge_topic_doc_v3(&mut connection, &document).is_err());
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );

        let plugin_id = SECOND_TOPIC_ID;
        connection
            .execute(
                "INSERT INTO notes_nodes(id,parent_id,sort_key,title,note,plugin_meta,is_readonly,created_at,updated_at,hlc) \
                 VALUES (?1,NULL,1024,'2026.07.21','',?2,NULL,'2026-07-21T00:00:00Z','2026-07-21T00:00:00Z',?3)",
                params![plugin_id, r#"{"kind":"date","date_key":"2026.07.21"}"#, HIGH_HLC],
            )
            .unwrap();
        let mut child = text_node(Some(plugin_id), HIGH_HLC, "stripped owner");
        child.readonly = Some(false);
        document.id = TOPIC_ID.to_string();
        document.root.title = "Ordinary topic".to_string();
        document.nodes = vec![child];
        assert!(merge_topic_doc_v3(&mut connection, &document).is_err());
        assert_eq!(
            connection
                .query_row(
                    "SELECT plugin_meta FROM notes_nodes WHERE id = ?1",
                    [plugin_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            r#"{"kind":"date","date_key":"2026.07.21"}"#
        );
    }

    #[test]
    fn v3_trash_cannot_claim_github_owned_rows() {
        let mut connection = v3_test_connection();
        let plugin_id = SECOND_TOPIC_ID;
        connection
            .execute(
                "INSERT INTO notes_nodes(id,parent_id,sort_key,title,note,plugin_meta,is_readonly,created_at,updated_at,hlc) \
                 VALUES (?1,NULL,1024,'2026.07.21','',?2,NULL,'2026-07-21T00:00:00Z','2026-07-21T00:00:00Z',?3)",
                params![plugin_id, r#"{"kind":"date","date_key":"2026.07.21"}"#, HIGH_HLC],
            )
            .unwrap();
        let document = TrashDoc {
            format_version: 3,
            max_hlc: HIGH_HLC.to_string(),
            purged: Vec::new(),
            nodes: vec![text_node(Some(plugin_id), HIGH_HLC, "plugin row")],
        };
        assert!(merge_trash_doc_v3(&mut connection, &document).is_err());
        assert!(connection
            .query_row(
                "SELECT deleted_at IS NULL FROM notes_nodes WHERE id = ?1",
                [plugin_id],
                |row| row.get::<_, bool>(0),
            )
            .unwrap());
    }

    fn github_notification_document(unread: bool, updated_at: &str) -> TopicDoc {
        let root_id = "6983f947-c134-44fc-bf46-db19f68125bf";
        let notification_key =
            "[\"github\",\"[\\\"https://api.github.com\\\",\\\"account-7\\\"]\",\"thread-17\"]";
        let notification = TopicNode {
            plugin_meta: Some(TopicPluginMeta::GithubNotification {
                notification_key: notification_key.to_string(),
                notification_type: "issue".to_string(),
                url: "https://github.com/acme/yonalist/issues/17".to_string(),
                updated_at: updated_at.to_string(),
                unread,
            }),
            id: Some(NODE_ID.to_string()),
            hlc: HIGH_HLC.to_string(),
            content: TopicContent::Text("Fix inline caret #17".to_string()),
            sibling_ordinal: 1,
            sort_key: SORT_KEY_STEP,
            ..text_node(Some(NODE_ID), HIGH_HLC, "Fix inline caret #17")
        };
        let date = TopicNode {
            plugin_meta: Some(TopicPluginMeta::GithubDate {
                date_key: "2026.07.21".to_string(),
            }),
            id: Some(SECOND_TOPIC_ID.to_string()),
            hlc: HIGH_HLC.to_string(),
            content: TopicContent::Text("2026.07.21".to_string()),
            children: vec![notification],
            ..text_node(Some(SECOND_TOPIC_ID), HIGH_HLC, "2026.07.21")
        };
        TopicDoc {
            id: root_id.to_string(),
            sort_key: SORT_KEY_STEP,
            max_hlc: HIGH_HLC.to_string(),
            root: TopicRoot {
                format_version: 3,
                title: "Github Notifications".to_string(),
                note: String::new(),
                hlc: HIGH_HLC.to_string(),
                starred: false,
                completed_at: None,
                archived_at: None,
                root_collapsed: false,
                root_readonly: None,
                plugin: Some("github-notifications".to_string()),
                plugin_children: Some("hybrid".to_string()),
                collapsed_groups: vec!["2026.07.21".to_string()],
            },
            nodes: vec![date],
        }
    }

    #[test]
    fn canonical_github_v3_self_echo_is_idempotent() {
        let mut connection = v3_test_connection();
        let document = github_notification_document(true, "2026-07-21T10:00:00.000Z");
        merge_topic_doc_v3(&mut connection, &document).expect("merge canonical Github topic");
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .expect("clear first-merge dirty markers");
        let before_hlc = connection
            .query_row(
                "SELECT hlc FROM notes_nodes WHERE id = ?1",
                [GITHUB_NOTIFICATIONS_ROOT_ID],
                |row| row.get::<_, String>(0),
            )
            .expect("read Github root HLC");

        let second =
            merge_topic_doc_v3(&mut connection, &document).expect("merge Github self echo");

        assert_eq!(second.applied, 0);
        assert!(!second.needs_write_back);
        assert_eq!(
            connection
                .query_row(
                    "SELECT hlc FROM notes_nodes WHERE id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, String>(0),
                )
                .expect("read Github root HLC after echo"),
            before_hlc
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM sync_dirty_nodes", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM notes_history_entries", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }

    #[test]
    fn github_source_disappearance_preserves_saved_notification_and_descendants() {
        const USER_CHILD_ID: &str = "44444444-4444-4444-8444-444444444444";
        let mut connection = v3_test_connection();
        let document = github_notification_document(true, "2026-07-21T10:00:00.000Z");
        merge_topic_doc_v3(&mut connection, &document).expect("merge saved Github tree");
        connection
            .execute(
                "INSERT INTO notes_nodes(id,parent_id,sort_key,title,note,is_readonly,created_at,updated_at,hlc) \
                 VALUES (?1,?2,1024,'Personal context','',1,'2026-07-21T00:00:00Z','2026-07-21T00:00:00Z',?3)",
                params![USER_CHILD_ID, NODE_ID, HIGH_HLC],
            )
            .expect("insert saved notification child");
        let mut disappeared = document;
        disappeared.nodes.clear();
        disappeared.root.collapsed_groups.clear();
        disappeared.root.hlc = FUTURE_HLC.to_string();
        disappeared.max_hlc = FUTURE_HLC.to_string();

        let report =
            merge_topic_doc_v3(&mut connection, &disappeared).expect("merge missing source item");

        assert!(report.needs_write_back);
        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            SECOND_TOPIC_ID
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id FROM notes_nodes WHERE id = ?1",
                    [USER_CHILD_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            NODE_ID
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT is_readonly FROM notes_nodes WHERE id = ?1",
                    [USER_CHILD_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn equal_notification_timestamp_allows_mark_read_but_rejects_stale_unread() {
        let root_id = "6983f947-c134-44fc-bf46-db19f68125bf";
        let date_id = SECOND_TOPIC_ID;
        let notification_id = NODE_ID;
        let state = r#"[]"#;
        let date_meta = r#"{"kind":"date","date_key":"2026.07.21"}"#;
        let unread_meta = r#"{"kind":"notification","notification_key":"[\"github\",\"[\\\"https://api.github.com\\\",\\\"account-7\\\"]\",\"thread-17\"]","type":"issue","url":"https://github.com/acme/yonalist/issues/17","updated_at":"2026-07-21T10:00:00.000Z","unread":true}"#;
        let read_meta = unread_meta.replace("\"unread\":true", "\"unread\":false");
        let setup = |connection: &Connection, notification_meta: &str| {
            for (id, parent, title, plugin_state, plugin_meta) in [
                (root_id, None, "Github Notifications", Some(state), None),
                (date_id, Some(root_id), "2026.07.21", None, Some(date_meta)),
                (
                    notification_id,
                    Some(date_id),
                    "Fix inline caret #17",
                    None,
                    Some(notification_meta),
                ),
            ] {
                connection
                    .execute(
                        "INSERT INTO notes_nodes(id,parent_id,sort_key,title,note,is_readonly,plugin_state,plugin_meta,created_at,updated_at,hlc) \
                         VALUES (?1,?2,1024,?3,'',NULL,?4,?5,'2026-07-21T00:00:00Z','2026-07-21T00:00:00Z',?6)",
                        params![id,parent,title,plugin_state,plugin_meta,HIGH_HLC],
                    )
                    .expect("insert Github v3 row");
            }
        };
        let mut stale = v3_test_connection();
        setup(&stale, &read_meta);
        merge_topic_doc_v3(
            &mut stale,
            &github_notification_document(true, "2026-07-21T10:00:00Z"),
        )
        .expect("merge stale unread source");
        assert_eq!(
            stale
                .query_row(
                    "SELECT plugin_state FROM notes_nodes WHERE id = ?1",
                    [root_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            r#"["2026.07.21"]"#
        );
        assert_eq!(
            stale
                .query_row(
                    "SELECT plugin_meta FROM notes_nodes WHERE id = ?1",
                    [notification_id],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            read_meta
        );

        let mut mark_read = v3_test_connection();
        setup(&mark_read, unread_meta);
        merge_topic_doc_v3(
            &mut mark_read,
            &github_notification_document(false, "2026-07-21T10:00:00.0Z"),
        )
        .expect("merge equal timestamp mark-read");
        let marked = mark_read
            .query_row(
                "SELECT plugin_meta FROM notes_nodes WHERE id = ?1",
                [notification_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert!(marked.contains("\"unread\":false"));
    }

    #[test]
    fn notification_merge_preserves_all_accepted_fractional_timestamp_precision() {
        let notification_id = NODE_ID;
        let set_notification_snapshot =
            |document: &mut TopicDoc, title: &str, note: &str, suffix: &str| {
                let notification = &mut document.nodes[0].children[0];
                notification.content = TopicContent::Text(title.to_string());
                notification.note = note.to_string();
                let Some(TopicPluginMeta::GithubNotification {
                    notification_type,
                    url,
                    ..
                }) = notification.plugin_meta.as_mut()
                else {
                    panic!("expected notification metadata")
                };
                *notification_type = format!("issue-{suffix}");
                *url = format!("https://github.com/acme/yonalist/issues/{suffix}");
            };

        let mut rejects_older = v3_test_connection();
        let local_newer = github_notification_document(false, "2026-07-21T10:00:00.0009Z");
        merge_topic_doc_v3(&mut rejects_older, &local_newer).expect("seed newer notification");
        let mut remote_older = github_notification_document(true, "2026-07-21T10:00:00.0001Z");
        set_notification_snapshot(
            &mut remote_older,
            "older remote snapshot",
            "older remote note",
            "older",
        );
        merge_topic_doc_v3(&mut rejects_older, &remote_older).expect("reject older notification");
        let (title, note, metadata): (String, String, String) = rejects_older
            .query_row(
                "SELECT title, note, plugin_meta FROM notes_nodes WHERE id = ?1",
                [notification_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(title, "Fix inline caret #17");
        assert_eq!(note, "");
        assert!(metadata.contains("\"updated_at\":\"2026-07-21T10:00:00.0009Z\""));
        assert!(metadata.contains("\"unread\":false"));

        let mut accepts_newer = v3_test_connection();
        let local_older = github_notification_document(false, "2026-07-21T10:00:00.0001Z");
        merge_topic_doc_v3(&mut accepts_newer, &local_older).expect("seed older notification");
        let mut remote_newer = github_notification_document(true, "2026-07-21T10:00:00.0009Z");
        set_notification_snapshot(
            &mut remote_newer,
            "newer remote snapshot",
            "newer remote note",
            "newer",
        );
        merge_topic_doc_v3(&mut accepts_newer, &remote_newer).expect("accept newer notification");
        let (title, note, metadata): (String, String, String) = accepts_newer
            .query_row(
                "SELECT title, note, plugin_meta FROM notes_nodes WHERE id = ?1",
                [notification_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(title, "newer remote snapshot");
        assert_eq!(note, "newer remote note");
        assert!(metadata.contains("\"updated_at\":\"2026-07-21T10:00:00.0009Z\""));
        assert!(metadata.contains("\"unread\":true"));
        assert!(metadata.contains("\"type\":\"issue-newer\""));
        assert!(metadata.contains("\"url\":\"https://github.com/acme/yonalist/issues/newer\""));
    }

    #[test]
    fn notification_timestamp_normalization_orders_instants_not_text() {
        assert_eq!(
            compare_github_notification_timestamps(
                "2026-07-21T10:00:00Z",
                "2026-07-21T10:00:00.0Z"
            ),
            Some(std::cmp::Ordering::Equal)
        );
        assert_eq!(
            compare_github_notification_timestamps(
                "2026-07-21T10:00:00.000Z",
                "2026-07-21T10:00:00Z"
            ),
            Some(std::cmp::Ordering::Equal)
        );
        assert_eq!(
            compare_github_notification_timestamps(
                "2026-07-21T10:00:00.0009Z",
                "2026-07-21T10:00:00.0001Z"
            ),
            Some(std::cmp::Ordering::Greater)
        );
        assert_eq!(
            compare_github_notification_timestamps(
                "2026-07-21T10:00:01Z",
                "2026-07-21T10:00:00Z"
            ),
            Some(std::cmp::Ordering::Greater)
        );
        assert_eq!(
            compare_github_notification_timestamps(
                "2026-07-21T09:59:59.999Z",
                "2026-07-21T10:00:00Z"
            ),
            Some(std::cmp::Ordering::Less)
        );
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

    fn dirty_ids(connection: &Connection) -> Vec<String> {
        let mut statement = connection
            .prepare("SELECT node_id FROM sync_dirty_nodes ORDER BY node_id")
            .expect("prepare dirty IDs");
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query dirty IDs")
            .collect::<Result<Vec<_>, _>>()
            .expect("read dirty IDs")
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

    fn column_string(connection: &Connection, id: &str, column: &str) -> String {
        connection
            .query_row(
                &format!("SELECT {column} FROM notes_nodes WHERE id = ?1"),
                [id],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_else(|_| panic!("read {column} for {id}"))
    }

    fn node_title(connection: &Connection, id: &str) -> String {
        column_string(connection, id, "title")
    }

    fn node_note(connection: &Connection, id: &str) -> String {
        column_string(connection, id, "note")
    }

    fn node_hlc(connection: &Connection, id: &str) -> String {
        column_string(connection, id, "hlc")
    }

    fn parent_of(connection: &Connection, id: &str) -> Option<String> {
        connection
            .query_row(
                "SELECT parent_id FROM notes_nodes WHERE id = ?1",
                [id],
                |row| row.get::<_, Option<String>>(0),
            )
            .expect("read parent")
    }

    fn node_exists_in_db(connection: &Connection, id: &str) -> bool {
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notes_nodes WHERE id = ?1)",
                [id],
                |row| row.get::<_, bool>(0),
            )
            .expect("existence")
    }

    fn is_live_root(connection: &Connection, id: &str) -> bool {
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notes_nodes \
                 WHERE id = ?1 AND parent_id IS NULL AND deleted_at IS NULL)",
                [id],
                |row| row.get::<_, bool>(0),
            )
            .expect("live root")
    }

    fn count_titled(connection: &Connection, title: &str) -> i64 {
        connection
            .query_row(
                "SELECT COUNT(*) FROM notes_nodes WHERE title = ?1",
                [title],
                |row| row.get::<_, i64>(0),
            )
            .expect("titled count")
    }

    fn seed_node(connection: &Connection, id: &str, parent: Option<&str>, hlc: &str, title: &str) {
        connection
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, note, created_at, updated_at, node_kind, hlc\
                 ) VALUES (?1, ?2, 1024, ?3, '', \
                           '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z', 'text', ?4)",
                params![id, parent, title, hlc],
            )
            .expect("seed node");
    }

    #[test]
    fn an_equal_hlc_with_changed_text_is_adopted_as_a_hand_edit_and_stays_idempotent() {
        let mut connection = test_connection();
        merge_topic_doc(
            &mut connection,
            &topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Original")]),
        )
        .expect("seed");

        // Same yid + HLC, different text = a hand edit that kept the metadata.
        let report = merge_topic_doc(
            &mut connection,
            &topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Hand edited")]),
        )
        .expect("adopt hand edit");
        assert!(report.needs_write_back);
        assert_eq!(node_title(&connection, NODE_ID), "Hand edited");
        let adopted_hlc = node_hlc(&connection, NODE_ID);
        assert!(adopted_hlc.as_str() > NODE_HLC);

        // Re-merging the written-back canonical document is a no-op.
        let mut canonical = topic_with(vec![text_node(Some(NODE_ID), &adopted_hlc, "Hand edited")]);
        canonical.max_hlc = adopted_hlc.clone();
        canonical.root.hlc = node_hlc(&connection, TOPIC_ID);
        let again = merge_topic_doc(&mut connection, &canonical).expect("re-merge canonical");
        assert_eq!(again.applied, 0);
        assert_eq!(node_title(&connection, NODE_ID), "Hand edited");
        assert_eq!(node_hlc(&connection, NODE_ID), adopted_hlc);
    }

    // R3: a legacy image root exports a lossy text echo (the file format has no
    // root image slot). Re-merging that echo must not read the flattening as a
    // hand edit and demote the root to text or delete its attachment.
    #[test]
    fn an_image_root_survives_its_own_lossy_text_echo() {
        let mut connection = test_connection();
        connection
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, note, created_at, updated_at, node_kind, hlc\
                 ) VALUES (?1, NULL, 1024, 'Photo', '', ?2, ?2, 'image', ?3)",
                params![TOPIC_ID, SYNC_TIMESTAMP_FALLBACK, ROOT_HLC],
            )
            .expect("seed image root");
        let attachment_id = deterministic_attachment_id(TOPIC_ID);
        connection
            .execute(
                "INSERT INTO notes_attachments(\
                   id, node_id, sort_key, relative_path, content_hash, original_name, mime_type, \
                   byte_size, intrinsic_width, intrinsic_height, display_width, created_at, updated_at\
                 ) VALUES (?1, ?2, 1024, ?3, ?4, 'photo.png', 'image/png', 0, 0, 0, 0, ?5, ?5)",
                params![
                    attachment_id,
                    TOPIC_ID,
                    format!("notes-assets/{}.png", "a".repeat(64)),
                    "a".repeat(64),
                    SYNC_TIMESTAMP_FALLBACK,
                ],
            )
            .expect("seed root attachment");
        // The attachment-insert trigger re-stamps the node's hlc, so read the
        // real stored value to build an echo with a genuinely EQUAL hlc — that
        // is the branch R3 fixes (an equal-hlc image root vs its text echo).
        let seeded_hlc = node_hlc(&connection, TOPIC_ID);

        // The exporter's lossy echo: same id/title/hlc, rendered as a text root.
        let echo = TopicDoc {
            id: TOPIC_ID.to_string(),
            sort_key: 1024,
            max_hlc: seeded_hlc.clone(),
            root: TopicRoot {
                format_version: 2,
                title: "Photo".to_string(),
                note: String::new(),
                hlc: seeded_hlc.clone(),
                starred: false,
                completed_at: None,
                archived_at: None,
                root_collapsed: false,
                root_readonly: None,
                plugin: None,
                plugin_children: None,
                collapsed_groups: Vec::new(),
            },
            nodes: Vec::new(),
        };
        merge_topic_doc(&mut connection, &echo).expect("re-merge lossy echo");

        let kind: String = connection
            .query_row(
                "SELECT node_kind FROM notes_nodes WHERE id = ?1",
                [TOPIC_ID],
                |row| row.get(0),
            )
            .expect("read root kind");
        assert_eq!(kind, "image", "the image root is not demoted to text");
        let attachments: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_attachments WHERE node_id = ?1",
                [TOPIC_ID],
                |row| row.get(0),
            )
            .expect("count root attachments");
        assert_eq!(attachments, 1, "the root attachment survives the echo");
        assert_eq!(
            node_hlc(&connection, TOPIC_ID),
            seeded_hlc,
            "the equal-HLC echo is skipped, not adopted under a fresh HLC"
        );
    }

    #[test]
    fn an_equal_hlc_with_identical_text_is_skipped() {
        let mut connection = test_connection();
        let doc = topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Same")]);
        merge_topic_doc(&mut connection, &doc).expect("seed");
        let report = merge_topic_doc(&mut connection, &doc).expect("re-merge identical");
        assert_eq!(report.applied, 0);
        assert_eq!(node_hlc(&connection, NODE_ID), NODE_HLC);
    }

    #[test]
    fn a_format_mimicking_bullet_with_an_unseen_yid_is_preserved_as_a_new_node() {
        let mut connection = test_connection();
        let fabricated = "99999999-9999-4999-8999-999999999999";
        let report = merge_topic_doc(
            &mut connection,
            &topic_with(vec![text_node(Some(fabricated), "", "Hand written")]),
        )
        .expect("merge fabricated bullet");
        assert_eq!(report.new_ids_assigned, 1);
        assert!(report.needs_write_back);
        // The untrusted yid is not adopted, but the content survives under a fresh id.
        assert!(!node_exists_in_db(&connection, fabricated));
        assert_eq!(count_titled(&connection, "Hand written"), 1);
    }

    #[test]
    fn a_remote_root_star_toggle_preserves_the_local_root_note() {
        let mut connection = test_connection();
        let mut seed = topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Child")]);
        seed.root.note = "Keep this note".to_string();
        merge_topic_doc(&mut connection, &seed).expect("seed root note");
        assert_eq!(node_note(&connection, TOPIC_ID), "Keep this note");

        // A higher-HLC remote root toggles the star while still carrying the note.
        let mut newer = topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Child")]);
        newer.root.note = "Keep this note".to_string();
        newer.root.starred = true;
        newer.root.hlc = HIGH_HLC.to_string();
        newer.max_hlc = HIGH_HLC.to_string();
        merge_topic_doc(&mut connection, &newer).expect("merge starred root");
        assert_eq!(node_note(&connection, TOPIC_ID), "Keep this note");
        assert_eq!(node_hlc(&connection, TOPIC_ID), HIGH_HLC);
    }

    #[test]
    fn a_merge_that_nests_past_the_cap_parks_the_shallowest_overflowing_subtree() {
        let mut connection = test_connection();
        let c1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let c2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let seed_hlc = "000000001-00-a3f2";
        // Shallow live tree root -> m(NODE_ID) -> c1 -> c2.
        seed_node(&connection, TOPIC_ID, None, seed_hlc, "root");
        seed_node(&connection, NODE_ID, Some(TOPIC_ID), seed_hlc, "m");
        seed_node(&connection, c1, Some(NODE_ID), seed_hlc, "c1");
        seed_node(&connection, c2, Some(c1), seed_hlc, "c2");

        // file2 re-parents m below a long chain so m lands one level under the cap.
        let x_count = MAX_NOTES_EXPORT_DEPTH - 3;
        let mut node = text_node(Some(NODE_ID), HIGH_HLC, "m");
        for _ in 0..x_count {
            node = TopicNode {
                children: vec![node],
                ..text_node(Some(&Uuid::new_v4().to_string()), HIGH_HLC, "x")
            };
        }
        let mut file2 = topic_with(vec![node]);
        file2.root.hlc = HIGH_HLC.to_string();
        file2.max_hlc = HIGH_HLC.to_string();

        let report = merge_topic_doc(&mut connection, &file2).expect("merge deep re-parent");
        assert!(report.parked_cycles >= 1);
        // c2 is the unique node past the cap, so it is the deterministic park choice.
        assert_eq!(
            parent_of(&connection, c2).as_deref(),
            Some(recovery_topic_id().as_str())
        );
        // c1 stays exactly at the cap under m.
        assert_eq!(parent_of(&connection, c1).as_deref(), Some(NODE_ID));
    }

    // R6: several independent over-deep subtrees are all parked in a single pass
    // (no per-park full re-scan), moving each offending subtree intact.
    #[test]
    fn over_deep_merge_parks_every_offending_subtree_in_one_pass() {
        let mut connection = test_connection();
        let seed_hlc = "000000001-00-a3f2";
        // Chain root(1) -> ... -> P(cap).
        seed_node(&connection, TOPIC_ID, None, seed_hlc, "root");
        let mut parent = TOPIC_ID.to_string();
        for _ in 0..(MAX_NOTES_EXPORT_DEPTH - 1) {
            let id = Uuid::new_v4().to_string();
            seed_node(&connection, &id, Some(&parent), seed_hlc, "chain");
            parent = id;
        }
        let p = parent;
        // Two siblings at cap+1, each with a deeper tail at cap+2.
        let a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let a2 = "a2a2a2a2-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let b2 = "b2b2b2b2-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        seed_node(&connection, a, Some(&p), seed_hlc, "A");
        seed_node(&connection, a2, Some(a), seed_hlc, "A2");
        seed_node(&connection, b, Some(&p), seed_hlc, "B");
        seed_node(&connection, b2, Some(b), seed_hlc, "B2");

        let mut report = MergeReport::default();
        let mut rebuilt = BTreeSet::new();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("start park transaction");
        park_overdeep_subtrees(&transaction, TOPIC_ID, &mut report, &mut rebuilt)
            .expect("park over-deep subtrees");
        transaction.commit().expect("commit park");

        assert_eq!(
            report.parked_cycles, 2,
            "both cap+1 roots parked in one pass"
        );
        let recovery = recovery_topic_id();
        assert_eq!(
            parent_of(&connection, a).as_deref(),
            Some(recovery.as_str())
        );
        assert_eq!(
            parent_of(&connection, b).as_deref(),
            Some(recovery.as_str())
        );
        // The deeper tails travel with their parked root (not re-parked).
        assert_eq!(parent_of(&connection, a2).as_deref(), Some(a));
        assert_eq!(parent_of(&connection, b2).as_deref(), Some(b));
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
    fn a_nested_child_hlc_is_observed_before_an_unstamped_parent_is_adopted() {
        // A5 adopts an unstamped, locally unseen parent as a fresh node (like the
        // no-yid path) instead of dropping it. Its nested child's FUTURE_HLC is
        // observed first, so the parent's freshly issued HLC sorts above it, and the
        // child stays attached to the adopted parent rather than being recovered.
        let mut connection = test_connection();
        let unstamped_parent_id = "33333333-3333-4333-8333-333333333333";
        let mut document = topic_with(vec![TopicNode {
            children: vec![text_node(Some(NODE_ID), FUTURE_HLC, "Nested child")],
            ..text_node(Some(unstamped_parent_id), "", "Unstamped parent")
        }]);
        document.max_hlc.clear();

        let report = merge_topic_doc(&mut connection, &document)
            .expect("merge nested evidence below an unstamped parent");
        assert!(report.new_ids_assigned >= 1);

        let (parent_id, parent_hlc): (String, String) = connection
            .query_row(
                "SELECT id, hlc FROM notes_nodes WHERE title = 'Unstamped parent'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("adopted unstamped parent");
        // The fabricated yid was not adopted; a fresh id carries the parent.
        assert_ne!(parent_id, unstamped_parent_id);
        assert!(parent_hlc.as_str() > FUTURE_HLC);
        assert_eq!(
            parent_of(&connection, NODE_ID).as_deref(),
            Some(parent_id.as_str())
        );
        assert_eq!(node_hlc(&connection, NODE_ID), FUTURE_HLC);
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
            format_version: 2,
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
            format_version: 2,
            max_hlc: HIGH_HLC.to_string(),
            purged: Vec::new(),
            nodes: vec![text_node(Some(NODE_ID), HIGH_HLC, "Deleted parent")],
        };
        let full_trash = TrashDoc {
            format_version: 2,
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
    fn archived_and_trash_order_recover_the_same_local_winning_archived_child() {
        let mut archived_then_trash = test_connection();
        let mut trash_then_archived = test_connection();
        let child_archived_hlc = "0swkd7qz7-00-a3f2";
        let child_trash_hlc = "0swkd7qz5-00-a3f2";
        let archived_at = "2026-07-21T00:00:00.000Z";
        let mut archived = topic_with(vec![text_node(
            Some(NODE_ID),
            child_archived_hlc,
            "Archived child",
        )]);
        archived.root.hlc = NODE_HLC.to_string();
        archived.root.archived_at = Some(archived_at.to_string());
        archived.max_hlc = child_archived_hlc.to_string();
        let trash = TrashDoc {
            format_version: 2,
            max_hlc: HIGH_HLC.to_string(),
            purged: Vec::new(),
            nodes: vec![TopicNode {
                children: vec![text_node(
                    Some(NODE_ID),
                    child_trash_hlc,
                    "Stale deleted child",
                )],
                ..text_node(Some(TOPIC_ID), HIGH_HLC, "Deleted archive root")
            }],
        };

        merge_topic_doc(&mut archived_then_trash, &archived).expect("seed archived tree first");
        merge_trash_doc(&mut archived_then_trash, &trash).expect("merge trash second");
        merge_trash_doc(&mut trash_then_archived, &trash).expect("seed trash tree first");
        merge_topic_doc(&mut trash_then_archived, &archived).expect("merge archived tree second");

        assert_eq!(
            reachable_lifecycle_state(&archived_then_trash),
            reachable_lifecycle_state(&trash_then_archived)
        );
        for connection in [&archived_then_trash, &trash_then_archived] {
            let recovered = connection
                .query_row(
                    "SELECT parent_id, deleted_at, archived_at, archive_root_id, hlc \
                     FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, String>(4)?,
                        ))
                    },
                )
                .expect("reachable archived winner");
            assert_eq!(
                (recovered.0, recovered.1, recovered.2, recovered.3),
                (Some(recovery_topic_id()), None, None, None)
            );
            assert!(recovered.4.as_str() > child_archived_hlc);
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
                        [NODE_ID],
                        |row| row.get::<_, i64>(0),
                    )
                    .expect("recovered archived winner dirtiness"),
                1
            );
        }
    }

    #[test]
    fn omitted_archived_trash_child_matches_reverse_order_recovery_state() {
        let mut omitted_after_archived = test_connection();
        let mut reverse_order = test_connection();
        let child_archived_hlc = "0swkd7qz7-00-a3f2";
        let child_trash_hlc = "0swkd7qz5-00-a3f2";
        let mut archived = topic_with(vec![text_node(
            Some(NODE_ID),
            child_archived_hlc,
            "Archived child",
        )]);
        archived.root.hlc = NODE_HLC.to_string();
        archived.root.archived_at = Some("2026-07-21T00:00:00.000Z".to_string());
        archived.max_hlc = child_archived_hlc.to_string();
        let parent_only_trash = TrashDoc {
            format_version: 2,
            max_hlc: HIGH_HLC.to_string(),
            purged: Vec::new(),
            nodes: vec![text_node(Some(TOPIC_ID), HIGH_HLC, "Deleted archive root")],
        };
        let full_trash = TrashDoc {
            format_version: 2,
            max_hlc: HIGH_HLC.to_string(),
            purged: Vec::new(),
            nodes: vec![TopicNode {
                children: vec![text_node(
                    Some(NODE_ID),
                    child_trash_hlc,
                    "Stale deleted child",
                )],
                ..text_node(Some(TOPIC_ID), HIGH_HLC, "Deleted archive root")
            }],
        };

        merge_topic_doc(&mut omitted_after_archived, &archived)
            .expect("seed omitted-order archived tree");
        merge_trash_doc(&mut omitted_after_archived, &parent_only_trash)
            .expect("merge archive-root-only trash");
        merge_trash_doc(&mut reverse_order, &full_trash)
            .expect("seed reverse-order archive trash tree");
        merge_topic_doc(&mut reverse_order, &archived).expect("merge reverse-order archived tree");

        assert_eq!(
            reachable_lifecycle_state(&omitted_after_archived),
            reachable_lifecycle_state(&reverse_order)
        );
        assert_eq!(
            omitted_after_archived
                .query_row(
                    "SELECT parent_id, deleted_at, archived_at, archive_root_id \
                     FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, Option<String>>(3)?,
                        ))
                    },
                )
                .expect("omitted reachable archived winner"),
            (Some(recovery_topic_id()), None, None, None)
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

        repair_affected_tree_integrity(&transaction, &affected_ids, &mut report, &mut rebuilt_ids)
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
    fn affected_integrity_repairs_archive_root_and_parent_chain_breaks_only() {
        let mut connection = test_connection();
        let archived_at = "2026-07-21T00:00:00.000Z";
        let valid_archive_root_id = "33333333-3333-4333-8333-333333333333";
        let deleted_parent_id = "44444444-4444-4444-8444-444444444444";
        let invalid_parent_id = "55555555-5555-4555-8555-555555555555";
        let active_parent_child_id = "66666666-6666-4666-8666-666666666666";
        let invalid_child_id = "77777777-7777-4777-8777-777777777777";
        let valid_archived_child_id = "88888888-8888-4888-8888-888888888888";
        let deleted_child_id = "99999999-9999-4999-8999-999999999999";
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("start archive integrity transaction");
        transaction
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, created_at, updated_at, hlc\
                 ) VALUES (?1, NULL, 1024, 'Active root', ?2, ?2, ?3)",
                params![TOPIC_ID, SYNC_TIMESTAMP_FALLBACK, NODE_HLC],
            )
            .expect("insert active root");
        transaction
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, created_at, updated_at, archived_at, \
                   archive_root_id, hlc\
                 ) VALUES (?1, NULL, 1024, 'Valid archive root', ?2, ?2, ?3, ?1, ?4)",
                params![
                    valid_archive_root_id,
                    SYNC_TIMESTAMP_FALLBACK,
                    archived_at,
                    NODE_HLC
                ],
            )
            .expect("insert valid archive root");
        transaction
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, created_at, updated_at, deleted_at, \
                   deleted_batch_id, hlc\
                 ) VALUES (?1, NULL, 1024, 'Deleted parent', ?2, ?2, ?3, 'batch', ?4)",
                params![
                    deleted_parent_id,
                    SYNC_TIMESTAMP_FALLBACK,
                    archived_at,
                    HIGH_HLC
                ],
            )
            .expect("insert deleted parent");
        transaction
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, created_at, updated_at, archived_at, \
                   archive_root_id, hlc\
                 ) VALUES (?1, ?2, 1024, 'Broken parent chain', ?3, ?3, ?4, ?5, ?6)",
                params![
                    NODE_ID,
                    deleted_parent_id,
                    SYNC_TIMESTAMP_FALLBACK,
                    archived_at,
                    valid_archive_root_id,
                    NODE_HLC
                ],
            )
            .expect("insert archived node below deleted parent");
        transaction
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, created_at, updated_at, archived_at, \
                   archive_root_id, hlc\
                 ) VALUES (?1, ?2, 2048, 'Broken archive root', ?3, ?3, ?4, ?5, ?6)",
                params![
                    active_parent_child_id,
                    TOPIC_ID,
                    SYNC_TIMESTAMP_FALLBACK,
                    archived_at,
                    deleted_parent_id,
                    NODE_HLC
                ],
            )
            .expect("insert archived node below active parent");
        transaction
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, created_at, updated_at, archived_at, \
                   archive_root_id, hlc\
                 ) VALUES (?1, ?2, 3072, 'Broken archived parent', ?3, ?3, ?4, ?5, ?6)",
                params![
                    invalid_parent_id,
                    TOPIC_ID,
                    SYNC_TIMESTAMP_FALLBACK,
                    archived_at,
                    deleted_parent_id,
                    NODE_HLC
                ],
            )
            .expect("insert invalid archived parent");
        transaction
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, created_at, updated_at, archived_at, \
                   archive_root_id, hlc\
                 ) VALUES (?1, ?2, 1024, 'Broken archived child', ?3, ?3, ?4, ?5, ?6)",
                params![
                    invalid_child_id,
                    invalid_parent_id,
                    SYNC_TIMESTAMP_FALLBACK,
                    archived_at,
                    deleted_parent_id,
                    NODE_HLC
                ],
            )
            .expect("insert invalid archived child");
        transaction
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, created_at, updated_at, archived_at, \
                   archive_root_id, hlc\
                 ) VALUES (?1, ?2, 1024, 'Valid archived child', ?3, ?3, ?4, ?2, ?5)",
                params![
                    valid_archived_child_id,
                    valid_archive_root_id,
                    SYNC_TIMESTAMP_FALLBACK,
                    archived_at,
                    NODE_HLC
                ],
            )
            .expect("insert valid archived child");
        transaction
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, created_at, updated_at, deleted_at, \
                   deleted_batch_id, hlc\
                 ) VALUES (?1, ?2, 1024, 'Deleted child', ?3, ?3, ?4, 'batch', ?5)",
                params![
                    deleted_child_id,
                    invalid_parent_id,
                    SYNC_TIMESTAMP_FALLBACK,
                    archived_at,
                    HIGH_HLC
                ],
            )
            .expect("insert deleted descendant");
        let affected_ids = BTreeSet::from([
            TOPIC_ID.to_string(),
            valid_archive_root_id.to_string(),
            deleted_parent_id.to_string(),
        ]);
        let mut report = MergeReport::default();
        let mut rebuilt_ids = BTreeSet::new();

        repair_affected_tree_integrity(&transaction, &affected_ids, &mut report, &mut rebuilt_ids)
            .expect("repair affected archive integrity");

        let lifecycle = |node_id: &str| {
            transaction
                .query_row(
                    "SELECT parent_id, deleted_at, archived_at, archive_root_id \
                     FROM notes_nodes WHERE id = ?1",
                    [node_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, Option<String>>(3)?,
                        ))
                    },
                )
                .expect("read repaired archive lifecycle")
        };
        assert_eq!(
            lifecycle(NODE_ID),
            (Some(recovery_topic_id()), None, None, None)
        );
        assert_eq!(
            lifecycle(active_parent_child_id),
            (Some(TOPIC_ID.to_string()), None, None, None)
        );
        assert_eq!(
            lifecycle(invalid_parent_id),
            (Some(TOPIC_ID.to_string()), None, None, None)
        );
        assert_eq!(
            lifecycle(invalid_child_id),
            (Some(invalid_parent_id.to_string()), None, None, None)
        );
        assert_eq!(
            lifecycle(valid_archived_child_id),
            (
                Some(valid_archive_root_id.to_string()),
                None,
                Some(archived_at.to_string()),
                Some(valid_archive_root_id.to_string())
            )
        );
        assert!(lifecycle(deleted_child_id).1.is_some());
        assert_eq!(
            rebuilt_ids,
            BTreeSet::from([
                NODE_ID.to_string(),
                active_parent_child_id.to_string(),
                invalid_parent_id.to_string(),
                invalid_child_id.to_string(),
            ])
        );
        assert!(report.needs_write_back);
        for node_id in &rebuilt_ids {
            assert_eq!(
                transaction
                    .query_row(
                        "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
                        [node_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .expect("repaired archive dirtiness"),
                1
            );
        }
    }

    #[test]
    fn equal_hlc_intact_archive_reapplication_is_a_no_op() {
        let mut connection = test_connection();
        let mut archived = topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Archived child")]);
        archived.root.archived_at = Some("2026-07-21T00:00:00.000Z".to_string());
        merge_topic_doc(&mut connection, &archived).expect("seed intact archive");
        let before = reachable_lifecycle_state(&connection);

        let report = merge_topic_doc(&mut connection, &archived).expect("repeat intact archive");

        assert_eq!(report.applied, 0);
        assert!(!report.needs_write_back);
        assert_eq!(reachable_lifecycle_state(&connection), before);
        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id, archived_at, archive_root_id, hlc \
                     FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    },
                )
                .expect("intact archived child"),
            (
                Some(TOPIC_ID.to_string()),
                archived.root.archived_at,
                Some(TOPIC_ID.to_string()),
                NODE_HLC.to_string()
            )
        );
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
            format_version: 2,
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
            format_version: 2,
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
                format_version: 2,
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
                format_version: 2,
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
                format_version: 2,
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
                format_version: 2,
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
            format_version: 2,
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
                format_version: 2,
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
                format_version: 2,
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
            format_version: 2,
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
                format_version: 2,
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
            format_version: 2,
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
            format_version: 2,
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
                format_version: 2,
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
            format_version: 2,
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
            format_version: 2,
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
            format_version: 2,
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
    fn a_known_node_is_not_overwritten_by_a_blank_hlc_file_entry() {
        // A blank file HLC still loses to a real local row (preserved invariant):
        // A5 only adopts a blank-HLC entry when its yid is *unseen* locally.
        let mut connection = test_connection();
        merge_topic_doc(
            &mut connection,
            &topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Local")]),
        )
        .expect("seed local node");

        let report = merge_topic_doc(
            &mut connection,
            &topic_with(vec![text_node(Some(NODE_ID), "", "File")]),
        )
        .expect("merge blank-hlc file entry");

        assert!(report.needs_write_back);
        assert_eq!(node_title(&connection, NODE_ID), "Local");
        assert_eq!(node_hlc(&connection, NODE_ID), NODE_HLC);
        assert_eq!(count_titled(&connection, "File"), 0);
    }

    #[test]
    fn a_hand_written_root_without_root_hlc_is_adopted_and_keeps_its_child() {
        // A5: a hand-written topic file whose root lacks `root_hlc` is adopted with
        // a fresh HLC as a live root (never falling into the RemoveTopic loop), and
        // its stamped child stays attached instead of being recovered.
        let mut connection = test_connection();
        let mut document = topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Child")]);
        document.root.hlc.clear();

        let report = merge_topic_doc(&mut connection, &document).expect("merge hand-written root");

        assert!(report.needs_write_back);
        assert!(is_live_root(&connection, TOPIC_ID));
        assert!(!node_hlc(&connection, TOPIC_ID).is_empty());
        assert_eq!(
            parent_of(&connection, NODE_ID).as_deref(),
            Some(TOPIC_ID),
            "the child stays under the adopted root rather than recovery"
        );
    }

    #[test]
    fn malformed_empty_purge_hlc_is_not_persisted() {
        let mut connection = test_connection();
        let trash = TrashDoc {
            format_version: 2,
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
                format_version: 2,
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
            format_version: 2,
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
    fn remote_trash_delete_dirties_the_unchanged_former_topic() {
        let mut connection = test_connection();
        merge_topic_doc(
            &mut connection,
            &topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Before delete")]),
        )
        .expect("seed active topic");
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();
        let mut deleted = text_node(Some(NODE_ID), HIGH_HLC, "Deleted remotely");
        deleted.from = Some((TOPIC_ID.to_string(), SORT_KEY_STEP));

        merge_trash_doc(
            &mut connection,
            &TrashDoc {
                format_version: 2,
                max_hlc: HIGH_HLC.to_string(),
                purged: Vec::new(),
                nodes: vec![deleted],
            },
        )
        .expect("merge remote deletion");

        assert!(dirty_ids(&connection).contains(&TOPIC_ID.to_string()));
    }

    #[test]
    fn remote_purge_dirties_the_deleted_roots_former_topic() {
        let mut connection = test_connection();
        merge_topic_doc(
            &mut connection,
            &topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Before purge")]),
        )
        .expect("seed active topic");
        let mut deleted = text_node(Some(NODE_ID), HIGH_HLC, "Deleted remotely");
        deleted.from = Some((TOPIC_ID.to_string(), SORT_KEY_STEP));
        merge_trash_doc(
            &mut connection,
            &TrashDoc {
                format_version: 2,
                max_hlc: HIGH_HLC.to_string(),
                purged: Vec::new(),
                nodes: vec![deleted],
            },
        )
        .expect("seed remote deletion");
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();

        merge_trash_doc(
            &mut connection,
            &TrashDoc {
                format_version: 2,
                max_hlc: FUTURE_HLC.to_string(),
                purged: vec![PurgedTombstone {
                    id: NODE_ID.to_string(),
                    hlc: FUTURE_HLC.to_string(),
                }],
                nodes: Vec::new(),
            },
        )
        .expect("merge remote purge");

        assert!(dirty_ids(&connection).contains(&TOPIC_ID.to_string()));
    }

    #[test]
    fn remote_topic_restore_dirties_the_unchanged_trash_document() {
        let mut connection = test_connection();
        merge_topic_doc(
            &mut connection,
            &topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Before delete")]),
        )
        .expect("seed active topic");
        let mut deleted = text_node(Some(NODE_ID), HIGH_HLC, "Deleted remotely");
        deleted.from = Some((TOPIC_ID.to_string(), SORT_KEY_STEP));
        merge_trash_doc(
            &mut connection,
            &TrashDoc {
                format_version: 2,
                max_hlc: HIGH_HLC.to_string(),
                purged: Vec::new(),
                nodes: vec![deleted],
            },
        )
        .expect("seed remote deletion");
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();
        let mut restored = topic_with(vec![text_node(
            Some(NODE_ID),
            FUTURE_HLC,
            "Restored remotely",
        )]);
        restored.max_hlc = FUTURE_HLC.to_string();

        merge_topic_doc(&mut connection, &restored).expect("merge remote restore");

        assert!(dirty_ids(&connection).contains(&TRASH_TOPIC_ID.to_string()));
    }

    #[test]
    fn remote_update_to_an_existing_topic_dirties_the_current_topic() {
        let mut connection = test_connection();
        merge_topic_doc(&mut connection, &topic_with(Vec::new())).expect("seed current topic");
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();
        let mut changed = topic_with(Vec::new());
        changed.root.title = "Changed remotely".to_string();
        changed.root.hlc = HIGH_HLC.to_string();
        changed.max_hlc = HIGH_HLC.to_string();

        merge_topic_doc(&mut connection, &changed).expect("merge remote update");

        assert!(dirty_ids(&connection).contains(&TOPIC_ID.to_string()));
    }

    #[test]
    fn remote_root_move_dirties_the_former_topic_removal_target() {
        let mut connection = test_connection();
        merge_topic_doc(&mut connection, &topic_with(Vec::new())).expect("seed former root");
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();
        let destination = TopicDoc {
            id: SECOND_TOPIC_ID.to_string(),
            sort_key: 2 * SORT_KEY_STEP,
            max_hlc: HIGH_HLC.to_string(),
            root: TopicRoot {
                format_version: 2,
                title: "Destination".to_string(),
                note: String::new(),
                hlc: HIGH_HLC.to_string(),
                starred: false,
                completed_at: None,
                archived_at: None,
                root_collapsed: false,
                root_readonly: None,
                plugin: None,
                plugin_children: None,
                collapsed_groups: Vec::new(),
            },
            nodes: vec![text_node(Some(TOPIC_ID), HIGH_HLC, "Moved former root")],
        };

        merge_topic_doc(&mut connection, &destination).expect("merge remote root move");

        let removal_marker = format!(
            "{}{}",
            crate::notes::schema::SYNC_REMOVE_TOPIC_PREFIX,
            TOPIC_ID
        );
        assert!(dirty_ids(&connection).contains(&removal_marker));
    }

    #[test]
    fn remote_deletion_of_metadata_absent_root_does_not_schedule_file_removal() {
        let mut connection = test_connection();
        connection
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, created_at, updated_at, hlc\
                 ) VALUES (?1, NULL, ?2, 'Restored without export', \
                           '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z', ?3)",
                params![TOPIC_ID, SORT_KEY_STEP, NODE_HLC],
            )
            .unwrap();
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();
        let deleted = text_node(Some(TOPIC_ID), HIGH_HLC, "Deleted before first export");

        merge_trash_doc(
            &mut connection,
            &TrashDoc {
                format_version: 2,
                max_hlc: HIGH_HLC.to_string(),
                purged: Vec::new(),
                nodes: vec![deleted],
            },
        )
        .expect("merge deletion before first topic export");

        let removal_marker = format!("{SYNC_REMOVE_TOPIC_PREFIX}{TOPIC_ID}");
        assert!(!dirty_ids(&connection).contains(&removal_marker));
        assert!(dirty_ids(&connection).is_empty());
    }

    #[test]
    fn local_win_against_remote_trash_dirties_reserved_trash() {
        let mut connection = test_connection();
        let mut local = topic_with(vec![text_node(Some(NODE_ID), FUTURE_HLC, "Newer local")]);
        local.max_hlc = FUTURE_HLC.to_string();
        merge_topic_doc(&mut connection, &local).expect("seed newer local node");
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();
        let mut stale = text_node(Some(NODE_ID), HIGH_HLC, "Older remote trash");
        stale.from = Some((TOPIC_ID.to_string(), SORT_KEY_STEP));

        let report = merge_trash_doc(
            &mut connection,
            &TrashDoc {
                format_version: 2,
                max_hlc: HIGH_HLC.to_string(),
                purged: Vec::new(),
                nodes: vec![stale],
            },
        )
        .expect("merge stale remote trash");

        assert!(report.needs_write_back);
        assert!(dirty_ids(&connection).contains(&TRASH_TOPIC_ID.to_string()));
    }

    #[test]
    fn purge_tombstone_never_deletes_a_newer_local_node() {
        let mut connection = test_connection();
        let mut newer = topic_with(vec![text_node(Some(NODE_ID), HIGH_HLC, "Newer")]);
        newer.max_hlc = HIGH_HLC.to_string();
        merge_topic_doc(&mut connection, &newer).expect("seed newer node");
        let trash = TrashDoc {
            format_version: 2,
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
