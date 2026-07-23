use crate::notes::attachments::AttachmentStorageLease;
use crate::notes::date_index::LocalDate;
#[cfg(test)]
use crate::notes::date_index::{LocalTodayProvider, SystemLocalTodayProvider};
use crate::notes::repository::{
    load_workspace, note_node_from_audit_json, rebuild_derived_for_nodes_at,
};
#[cfg(test)]
use crate::notes::types::NotesHistoryReplayResult;
use crate::notes::types::{
    validate_note_id, NoteAttachment, NoteId, NoteNode, NoteNodeKind, NotesHistoryContext,
    NotesHistoryReplayOutcome, NotesHistoryResetInput, NotesHistoryState, NotesHistoryStatus,
    NotesMutationResult, NotesPrepareNavigationInput, NotesPruneHistoryInput, NotesWorkspace,
    NotesWorkspaceScope, MAX_NOTE_ATTACHMENTS_PER_NODE, MAX_NOTE_ATTACHMENTS_PER_VAULT,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Deserialize;
use std::collections::{BTreeSet, HashMap, HashSet};
use uuid::Uuid;

pub(crate) const HISTORY_MAX_ENTRIES: i64 = 100;
pub(crate) const HISTORY_MAX_BYTES: i64 = 50 * 1024 * 1024;

const NODE_JSON_NEW: &str = "json_object(\
  'id', NEW.id, 'parent_id', NEW.parent_id, 'sort_key', NEW.sort_key, \
  'title', NEW.title, 'note', NEW.note, 'image_offset_utf16', NEW.image_offset_utf16, 'layout_mode', NEW.layout_mode, \
  'is_collapsed', NEW.is_collapsed, 'is_starred', NEW.is_starred, \
  'completed_at', NEW.completed_at, 'created_at', NEW.created_at, \
  'updated_at', NEW.updated_at, 'deleted_at', NEW.deleted_at, \
  'deleted_batch_id', NEW.deleted_batch_id, 'archived_at', NEW.archived_at, \
  'archive_root_id', NEW.archive_root_id, 'nodeKind', NEW.node_kind)";
const NODE_JSON_OLD: &str = "json_object(\
  'id', OLD.id, 'parent_id', OLD.parent_id, 'sort_key', OLD.sort_key, \
  'title', OLD.title, 'note', OLD.note, 'image_offset_utf16', OLD.image_offset_utf16, 'layout_mode', OLD.layout_mode, \
  'is_collapsed', OLD.is_collapsed, 'is_starred', OLD.is_starred, \
  'completed_at', OLD.completed_at, 'created_at', OLD.created_at, \
  'updated_at', OLD.updated_at, 'deleted_at', OLD.deleted_at, \
  'deleted_batch_id', OLD.deleted_batch_id, 'archived_at', OLD.archived_at, \
  'archive_root_id', OLD.archive_root_id, 'nodeKind', OLD.node_kind)";
#[allow(dead_code)]
pub(crate) const V3_NODE_JSON_NEW: &str = "json_object(\
  'id', NEW.id, 'parent_id', NEW.parent_id, 'sort_key', NEW.sort_key, \
  'title', NEW.title, 'note', NEW.note, 'image_offset_utf16', NEW.image_offset_utf16, 'layout_mode', NEW.layout_mode, \
  'is_collapsed', NEW.is_collapsed, 'is_starred', NEW.is_starred, \
  'completed_at', NEW.completed_at, 'created_at', NEW.created_at, \
  'updated_at', NEW.updated_at, 'deleted_at', NEW.deleted_at, \
  'deleted_batch_id', NEW.deleted_batch_id, 'archived_at', NEW.archived_at, \
  'archive_root_id', NEW.archive_root_id, 'nodeKind', NEW.node_kind, \
  'is_readonly', NEW.is_readonly, 'plugin_state', NEW.plugin_state, \
  'plugin_meta', NEW.plugin_meta)";
#[allow(dead_code)]
pub(crate) const V3_NODE_JSON_OLD: &str = "json_object(\
  'id', OLD.id, 'parent_id', OLD.parent_id, 'sort_key', OLD.sort_key, \
  'title', OLD.title, 'note', OLD.note, 'image_offset_utf16', OLD.image_offset_utf16, 'layout_mode', OLD.layout_mode, \
  'is_collapsed', OLD.is_collapsed, 'is_starred', OLD.is_starred, \
  'completed_at', OLD.completed_at, 'created_at', OLD.created_at, \
  'updated_at', OLD.updated_at, 'deleted_at', OLD.deleted_at, \
  'deleted_batch_id', OLD.deleted_batch_id, 'archived_at', OLD.archived_at, \
  'archive_root_id', OLD.archive_root_id, 'nodeKind', OLD.node_kind, \
  'is_readonly', OLD.is_readonly, 'plugin_state', OLD.plugin_state, \
  'plugin_meta', OLD.plugin_meta)";
const ATTACHMENT_JSON_NEW: &str = "json_object(\
  'id', NEW.id, 'node_id', NEW.node_id, 'sort_key', NEW.sort_key, \
  'relative_path', NEW.relative_path, 'content_hash', NEW.content_hash, \
  'original_name', NEW.original_name, 'mime_type', NEW.mime_type, \
  'byte_size', NEW.byte_size, 'intrinsic_width', NEW.intrinsic_width, \
  'intrinsic_height', NEW.intrinsic_height, 'display_width', NEW.display_width, \
  'created_at', NEW.created_at, 'updated_at', NEW.updated_at)";
const ATTACHMENT_JSON_OLD: &str = "json_object(\
  'id', OLD.id, 'node_id', OLD.node_id, 'sort_key', OLD.sort_key, \
  'relative_path', OLD.relative_path, 'content_hash', OLD.content_hash, \
  'original_name', OLD.original_name, 'mime_type', OLD.mime_type, \
  'byte_size', OLD.byte_size, 'intrinsic_width', OLD.intrinsic_width, \
  'intrinsic_height', OLD.intrinsic_height, 'display_width', OLD.display_width, \
  'created_at', OLD.created_at, 'updated_at', OLD.updated_at)";

fn validate_history_id(label: &str, value: &str) -> Result<(), String> {
    validate_note_id(value).map_err(|_| format!("{label} must be a canonical UUID v4 string."))
}

pub(crate) fn validate_context(context: &NotesHistoryContext) -> Result<(), String> {
    validate_history_id("Notes history session ID", &context.session_id)?;
    validate_history_id("Notes history entry ID", &context.entry_id)?;
    let command_kind = context.command_kind.trim();
    if command_kind.is_empty() || command_kind.len() > 128 {
        return Err("Notes history command kind must contain 1 to 128 characters.".to_string());
    }
    Ok(())
}

fn install_audit_infrastructure(connection: &Connection) -> Result<(), String> {
    let has_plugin_storage: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('notes_nodes') WHERE name = 'is_readonly')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not inspect Notes history node storage: {error}"))?;
    let node_json_new = if has_plugin_storage {
        V3_NODE_JSON_NEW
    } else {
        NODE_JSON_NEW
    };
    let node_json_old = if has_plugin_storage {
        V3_NODE_JSON_OLD
    } else {
        NODE_JSON_OLD
    };
    let sql = format!(
        r#"
        CREATE TEMP TABLE IF NOT EXISTS notes_history_context (
          session_id TEXT NOT NULL,
          entry_id TEXT NOT NULL,
          command_kind TEXT NOT NULL
        );
        CREATE TEMP TABLE IF NOT EXISTS notes_history_audit (
          table_name TEXT NOT NULL,
          row_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          before_json TEXT,
          after_json TEXT,
          PRIMARY KEY (table_name, row_id)
        );
        CREATE TEMP TABLE IF NOT EXISTS notes_history_pruned_attachment_paths (
          relative_path TEXT PRIMARY KEY
        );
        CREATE TEMP TABLE IF NOT EXISTS notes_history_pruned_entry_ids (
          id TEXT PRIMARY KEY,
          ordinal INTEGER NOT NULL
        );
        CREATE TEMP TABLE IF NOT EXISTS notes_history_mutation_result (
          history_entry_id TEXT,
          can_undo INTEGER NOT NULL,
          can_redo INTEGER NOT NULL
        );

        CREATE TEMP TRIGGER IF NOT EXISTS notes_history_nodes_insert
        AFTER INSERT ON notes_nodes
        WHEN EXISTS (SELECT 1 FROM notes_history_context)
        BEGIN
          INSERT INTO notes_history_audit(table_name, row_id, ordinal, before_json, after_json)
          VALUES ('notes_nodes', NEW.id,
                  (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM notes_history_audit),
                  NULL, {node_json_new})
          ON CONFLICT(table_name, row_id) DO UPDATE SET after_json = excluded.after_json;
        END;
        CREATE TEMP TRIGGER IF NOT EXISTS notes_history_nodes_update
        AFTER UPDATE ON notes_nodes
        WHEN EXISTS (SELECT 1 FROM notes_history_context)
        BEGIN
          INSERT INTO notes_history_audit(table_name, row_id, ordinal, before_json, after_json)
          VALUES ('notes_nodes', NEW.id,
                  (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM notes_history_audit),
                  {node_json_old}, {node_json_new})
          ON CONFLICT(table_name, row_id) DO UPDATE SET after_json = excluded.after_json;
        END;
        CREATE TEMP TRIGGER IF NOT EXISTS notes_history_nodes_delete
        AFTER DELETE ON notes_nodes
        WHEN EXISTS (SELECT 1 FROM notes_history_context)
        BEGIN
          INSERT INTO notes_history_audit(table_name, row_id, ordinal, before_json, after_json)
          VALUES ('notes_nodes', OLD.id,
                  (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM notes_history_audit),
                  {node_json_old}, NULL)
          ON CONFLICT(table_name, row_id) DO UPDATE SET after_json = NULL;
        END;

        CREATE TEMP TRIGGER IF NOT EXISTS notes_history_attachments_insert
        AFTER INSERT ON notes_attachments
        WHEN EXISTS (SELECT 1 FROM notes_history_context)
        BEGIN
          INSERT INTO notes_history_audit(table_name, row_id, ordinal, before_json, after_json)
          VALUES ('notes_attachments', NEW.id,
                  (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM notes_history_audit),
                  NULL, {ATTACHMENT_JSON_NEW})
          ON CONFLICT(table_name, row_id) DO UPDATE SET after_json = excluded.after_json;
        END;
        CREATE TEMP TRIGGER IF NOT EXISTS notes_history_attachments_update
        AFTER UPDATE ON notes_attachments
        WHEN EXISTS (SELECT 1 FROM notes_history_context)
        BEGIN
          INSERT INTO notes_history_audit(table_name, row_id, ordinal, before_json, after_json)
          VALUES ('notes_attachments', NEW.id,
                  (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM notes_history_audit),
                  {ATTACHMENT_JSON_OLD}, {ATTACHMENT_JSON_NEW})
          ON CONFLICT(table_name, row_id) DO UPDATE SET after_json = excluded.after_json;
        END;
        CREATE TEMP TRIGGER IF NOT EXISTS notes_history_attachments_delete
        AFTER DELETE ON notes_attachments
        WHEN EXISTS (SELECT 1 FROM notes_history_context)
        BEGIN
          INSERT INTO notes_history_audit(table_name, row_id, ordinal, before_json, after_json)
          VALUES ('notes_attachments', OLD.id,
                  (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM notes_history_audit),
                  {ATTACHMENT_JSON_OLD}, NULL)
          ON CONFLICT(table_name, row_id) DO UPDATE SET after_json = NULL;
        END;
        "#
    );
    connection
        .execute_batch(&sql)
        .map_err(|error| format!("Could not prepare Notes history auditing: {error}"))
}

pub(crate) fn install_session_history(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA temp_store = MEMORY; \
             CREATE TEMP TABLE IF NOT EXISTS notes_history_epoch (value TEXT NOT NULL); \
             CREATE TEMP TABLE IF NOT EXISTS notes_history_entries (\
               id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER NOT NULL, \
               is_undone INTEGER NOT NULL DEFAULT 0, estimated_bytes INTEGER NOT NULL DEFAULT 0, \
               command_kind TEXT NOT NULL); \
             CREATE UNIQUE INDEX IF NOT EXISTS temp.notes_history_session_sequence \
               ON notes_history_entries(session_id, sequence); \
             CREATE TEMP TABLE IF NOT EXISTS notes_history_changes (\
               entry_id TEXT NOT NULL REFERENCES notes_history_entries(id) ON DELETE CASCADE, \
               table_name TEXT NOT NULL, row_id TEXT NOT NULL, ordinal INTEGER NOT NULL, \
               before_json TEXT, after_json TEXT, PRIMARY KEY(entry_id, table_name, row_id));",
        )
        .map_err(|error| format!("Could not install TEMP Notes history: {error}"))?;
    connection
        .execute(
            "INSERT INTO notes_history_epoch(value) SELECT ?1 \
             WHERE NOT EXISTS (SELECT 1 FROM notes_history_epoch)",
            [Uuid::new_v4().to_string()],
        )
        .map_err(|error| format!("Could not initialize Notes history epoch: {error}"))?;
    install_audit_infrastructure(connection)?;
    crate::notes::image_atom::install_operation_receipts(connection)
}

// Consumed by the epoch-aware protocol built on this storage layer.
#[allow(dead_code)]
pub(crate) fn history_epoch(connection: &Connection) -> Result<String, String> {
    connection
        .query_row("SELECT value FROM notes_history_epoch", [], |row| {
            row.get(0)
        })
        .map_err(|error| format!("Could not read the Notes history epoch: {error}"))
}

pub(crate) fn require_epoch(connection: &Connection, expected_epoch: &str) -> Result<(), String> {
    #[cfg(test)]
    if expected_epoch == crate::notes::types::TEST_CURRENT_HISTORY_EPOCH {
        return Ok(());
    }
    if history_epoch(connection)? != expected_epoch {
        return Err("The Notes history epoch is stale.".to_string());
    }
    Ok(())
}

pub(crate) fn history_state(
    connection: &Connection,
    session_id: &str,
    pruned_entry_ids: Vec<String>,
) -> Result<NotesHistoryState, String> {
    validate_history_id("Notes history session ID", session_id)?;
    let (next_undo_entry_id, next_redo_entry_id) = connection
        .query_row(
            "SELECT \
               (SELECT id FROM notes_history_entries \
                WHERE session_id = ?1 AND is_undone = 0 \
                ORDER BY sequence DESC LIMIT 1), \
               (SELECT id FROM notes_history_entries \
                WHERE session_id = ?1 AND is_undone = 1 \
                ORDER BY sequence ASC LIMIT 1)",
            [session_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .map_err(|error| format!("Could not read Notes history state: {error}"))?;
    Ok(NotesHistoryState {
        can_undo: next_undo_entry_id.is_some(),
        can_redo: next_redo_entry_id.is_some(),
        history_epoch: history_epoch(connection)?,
        next_undo_entry_id,
        next_redo_entry_id,
        pruned_entry_ids,
    })
}

fn begin_audit(connection: &Connection, context: &NotesHistoryContext) -> Result<(), String> {
    require_epoch(connection, &context.history_epoch)?;
    install_audit_infrastructure(connection)?;
    let active: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_history_context)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not inspect Notes history auditing: {error}"))?;
    if active {
        return Err("A Notes history mutation is already active on this connection.".to_string());
    }
    connection
        .execute_batch(
            "DELETE FROM notes_history_audit; \
             DELETE FROM notes_history_pruned_attachment_paths; \
             DELETE FROM notes_history_pruned_entry_ids; \
             DELETE FROM notes_history_mutation_result;",
        )
        .and_then(|_| {
            connection.execute(
                "INSERT INTO notes_history_context(session_id, entry_id, command_kind) VALUES (?1, ?2, ?3)",
                params![context.session_id, context.entry_id, context.command_kind.trim()],
            )
        })
        .map_err(|error| format!("Could not start Notes history auditing: {error}"))?;
    Ok(())
}

fn end_audit(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch("DELETE FROM notes_history_context; DELETE FROM notes_history_audit;")
        .map_err(|error| format!("Could not finish Notes history auditing: {error}"))
}

/// Incremental view of exactly the rows a single audited mutation touched,
/// read from the TEMP `notes_history_audit` table before it is cleared.
#[derive(Default)]
pub(crate) struct MutationDelta {
    pub(crate) changed_nodes: Vec<NoteNode>,
    pub(crate) removed_node_ids: Vec<NoteId>,
    pub(crate) changed_attachments: Vec<NoteAttachment>,
}

pub(crate) struct HistoryTransactionResult {
    pub(crate) workspace: NotesWorkspace,
    pub(crate) history_entry_id: Option<String>,
    pub(crate) state: NotesHistoryState,
    pub(crate) pruned_attachment_paths: Vec<String>,
    /// `Some` only when the mutation ran under a history context; `None`
    /// mutations expose no audit rows, so the full workspace stays authoritative.
    pub(crate) delta: Option<MutationDelta>,
}

impl HistoryTransactionResult {
    pub(crate) fn into_mutation_result(self) -> NotesMutationResult {
        let (changed_nodes, removed_node_ids, changed_attachments) = match self.delta {
            Some(delta) => (
                Some(delta.changed_nodes),
                Some(delta.removed_node_ids),
                Some(delta.changed_attachments),
            ),
            None => (None, None, None),
        };
        NotesMutationResult {
            workspace: self.workspace,
            history_entry_id: self.history_entry_id,
            state: self.state,
            changed_nodes,
            removed_node_ids,
            changed_attachments,
            // Set by `notes_import_subtree` after this result is built; every
            // other mutation leaves it unset.
            imported_root_ids: None,
            // Set by batch duplicate after this result is built; every other
            // mutation leaves it unset.
            duplicated_root_ids: None,
        }
    }
}

/// Read the delta rows the audit triggers captured for the mutation that just
/// committed. The TEMP audit table coalesces per (table, row) with the latest
/// `after_json`, so a created-then-deleted row nets out (`before IS after`) and
/// is skipped, matching how `finalize_transaction` compacts persisted changes.
///
/// Removed attachments are intentionally not surfaced: the delta contract only
/// carries created/updated attachments, and the full workspace still covers the
/// rest.
fn read_mutation_delta(connection: &Connection) -> Result<MutationDelta, String> {
    let mut statement = connection
        .prepare(
            "SELECT table_name, row_id, after_json \
             FROM notes_history_audit \
             WHERE before_json IS NOT after_json \
             ORDER BY ordinal",
        )
        .map_err(|error| format!("Could not prepare the Notes mutation delta: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|error| format!("Could not read the Notes mutation delta: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not collect the Notes mutation delta: {error}"))?;

    let mut delta = MutationDelta::default();
    for (table_name, row_id, after_json) in rows {
        match (table_name.as_str(), after_json) {
            ("notes_nodes", Some(after)) => {
                delta.changed_nodes.push(note_node_from_audit_json(&after)?);
            }
            ("notes_nodes", None) => delta.removed_node_ids.push(row_id),
            ("notes_attachments", Some(after)) => {
                let attachment =
                    serde_json::from_str::<NoteAttachment>(&after).map_err(|error| {
                        format!("Could not decode an audited Notes attachment: {error}")
                    })?;
                delta.changed_attachments.push(attachment);
            }
            _ => {}
        }
    }
    Ok(delta)
}

pub(crate) fn with_history_transaction_and_prunes(
    connection: &mut Connection,
    context: Option<&NotesHistoryContext>,
    operation: impl FnOnce(&mut Connection) -> Result<NotesWorkspace, String>,
) -> Result<HistoryTransactionResult, String> {
    let Some(context) = context else {
        return Err("Notes mutations require a history context.".to_string());
    };
    validate_context(context)?;
    begin_audit(connection, context)?;
    let result = operation(connection);
    let committed_result = if result.is_ok() {
        (|| {
            let mut statement = connection
                .prepare(
                    "SELECT relative_path FROM notes_history_pruned_attachment_paths \
                     ORDER BY relative_path",
                )
                .map_err(|error| {
                    format!("Could not prepare pruned Notes attachment cleanup: {error}")
                })?;
            let paths = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| {
                    format!("Could not read pruned Notes attachment cleanup: {error}")
                })?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| {
                    format!("Could not collect pruned Notes attachment cleanup: {error}")
                });
            let paths = paths?;
            let pruned_entry_ids = {
                let mut statement = connection
                    .prepare("SELECT id FROM notes_history_pruned_entry_ids ORDER BY ordinal, id")
                    .map_err(|error| {
                        format!("Could not prepare pruned Notes history IDs: {error}")
                    })?;
                let ids = statement
                    .query_map([], |row| row.get::<_, String>(0))
                    .map_err(|error| format!("Could not read pruned Notes history IDs: {error}"))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| {
                        format!("Could not collect pruned Notes history IDs: {error}")
                    })?;
                ids
            };
            let mutation = connection
                .query_row(
                    "SELECT history_entry_id, can_undo, can_redo \
                     FROM notes_history_mutation_result",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, bool>(1)?,
                            row.get::<_, bool>(2)?,
                        ))
                    },
                )
                .map_err(|error| {
                    format!("Could not read the committed Notes mutation result: {error}")
                })?;
            let delta = read_mutation_delta(connection)?;
            let state = history_state(connection, &context.session_id, pruned_entry_ids)?;
            Ok((paths, mutation, delta, state))
        })()
    } else {
        Ok((
            Vec::new(),
            (None, false, false),
            MutationDelta::default(),
            NotesHistoryState::default(),
        ))
    };
    let cleanup = end_audit(connection);
    match (result, committed_result, cleanup) {
        (Err(error), _, _) => Err(error),
        (Ok(_), Err(error), _) | (Ok(_), Ok(_), Err(error)) => Err(error),
        (
            Ok(workspace),
            Ok((pruned_attachment_paths, (history_entry_id, _, _), delta, state)),
            Ok(()),
        ) => Ok(HistoryTransactionResult {
            workspace,
            history_entry_id,
            state,
            pruned_attachment_paths,
            delta: Some(delta),
        }),
    }
}

#[cfg(test)]
pub(crate) fn with_untracked_transaction_and_prunes_for_test(
    connection: &mut Connection,
    operation: impl FnOnce(&mut Connection) -> Result<NotesWorkspace, String>,
) -> Result<HistoryTransactionResult, String> {
    operation(connection).map(|workspace| HistoryTransactionResult {
        workspace,
        history_entry_id: None,
        state: NotesHistoryState::default(),
        pruned_attachment_paths: Vec::new(),
        delta: None,
    })
}

#[cfg(test)]
pub(crate) fn with_history_transaction(
    connection: &mut Connection,
    context: Option<&NotesHistoryContext>,
    operation: impl FnOnce(&mut Connection) -> Result<NotesWorkspace, String>,
) -> Result<NotesWorkspace, String> {
    match context {
        Some(context) => with_history_transaction_and_prunes(connection, Some(context), operation)
            .map(|result| result.workspace),
        None => with_untracked_transaction_and_prunes_for_test(connection, operation)
            .map(|result| result.workspace),
    }
}

pub(crate) fn has_active_context(connection: &Connection) -> Result<bool, String> {
    let table_exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_temp_master WHERE type = 'table' AND name = 'notes_history_context')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not inspect Notes history context: {error}"))?;
    if !table_exists {
        return Ok(false);
    }
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_history_context)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not read Notes history context: {error}"))
}

fn record_pruned_attachment_paths(
    transaction: &Transaction<'_>,
    entry_query: &str,
    parameters: impl rusqlite::Params + Copy,
) -> Result<(), String> {
    for json_column in ["before_json", "after_json"] {
        transaction
            .execute(
                &format!(
                    "INSERT OR IGNORE INTO notes_history_pruned_attachment_paths(relative_path) \
                     SELECT json_extract({json_column}, '$.relative_path') \
                     FROM notes_history_changes \
                     WHERE table_name = 'notes_attachments' \
                       AND {json_column} IS NOT NULL \
                       AND entry_id IN ({entry_query})"
                ),
                parameters,
            )
            .map_err(|error| {
                format!("Could not retain pruned Notes attachment cleanup paths: {error}")
            })?;
    }
    Ok(())
}

fn record_pruned_entry_ids(
    transaction: &Transaction<'_>,
    entry_query: &str,
    parameters: impl rusqlite::Params,
) -> Result<Vec<String>, String> {
    let entry_ids = {
        let mut statement = transaction
            .prepare(entry_query)
            .map_err(|error| format!("Could not prepare pruned Notes history IDs: {error}"))?;
        let ids = statement
            .query_map(parameters, |row| row.get::<_, String>(0))
            .map_err(|error| format!("Could not read pruned Notes history IDs: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not collect pruned Notes history IDs: {error}"))?;
        ids
    };
    let mut ordinal: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(ordinal), 0) FROM notes_history_pruned_entry_ids",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not order pruned Notes history IDs: {error}"))?;
    for entry_id in &entry_ids {
        ordinal += 1;
        transaction
            .execute(
                "INSERT OR IGNORE INTO notes_history_pruned_entry_ids(id, ordinal) VALUES (?1, ?2)",
                params![entry_id, ordinal],
            )
            .map_err(|error| format!("Could not retain a pruned Notes history ID: {error}"))?;
    }
    Ok(entry_ids)
}

fn take_pruned_attachment_paths(connection: &Connection) -> Result<Vec<String>, String> {
    let paths = {
        let mut statement = connection
            .prepare(
                "SELECT relative_path FROM notes_history_pruned_attachment_paths ORDER BY relative_path",
            )
            .map_err(|error| format!("Could not prepare pruned Notes attachment paths: {error}"))?;
        let paths = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("Could not read pruned Notes attachment paths: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not collect pruned Notes attachment paths: {error}"))?;
        paths
    };
    connection
        .execute("DELETE FROM notes_history_pruned_attachment_paths", [])
        .map_err(|error| format!("Could not clear pruned Notes attachment paths: {error}"))?;
    Ok(paths)
}

pub(crate) fn finalize_transaction(transaction: &Transaction<'_>) -> Result<(), String> {
    let context = transaction
        .query_row(
            "SELECT session_id, entry_id, command_kind FROM notes_history_context LIMIT 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|error| format!("Could not read active Notes history context: {error}"))?;
    let audit = {
        let mut statement = transaction
            .prepare("SELECT table_name, row_id, ordinal, before_json, after_json FROM notes_history_audit ORDER BY ordinal")
            .map_err(|error| format!("Could not prepare Notes history changes: {error}"))?;
        let changes = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(|error| format!("Could not read Notes history changes: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not collect Notes history changes: {error}"))?;
        changes
    };
    if audit.is_empty() {
        return record_mutation_result(transaction, &context.0, &context.1);
    }

    let existing = transaction
        .query_row(
            "SELECT session_id, sequence, is_undone, rowid FROM notes_history_entries WHERE id = ?1",
            [&context.1],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Could not inspect Notes history entry: {error}"))?;
    let entry_exists = if let Some((session_id, sequence, is_undone, row_id)) = existing {
        let latest_sequence: i64 = transaction
            .query_row(
                "SELECT COALESCE(MAX(sequence), 0) FROM notes_history_entries WHERE session_id = ?1",
                [&context.0],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not inspect Notes history order: {error}"))?;
        let latest_row_id: i64 = transaction
            .query_row(
                "SELECT rowid FROM notes_history_entries ORDER BY rowid DESC, id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not inspect global Notes history order: {error}"))?;
        if session_id != context.0
            || is_undone
            || sequence != latest_sequence
            || row_id != latest_row_id
        {
            return Err("A Notes history entry can only coalesce with the latest applied entry in the database.".to_string());
        }
        true
    } else {
        false
    };
    let unresolved_redo: bool = transaction
        .query_row(
            "SELECT EXISTS(\
               SELECT 1 FROM notes_history_entries entry \
               JOIN notes_image_atom_operations operation ON operation.operation_id = entry.id \
               WHERE entry.is_undone = 1 AND operation.acknowledged = 0\
             )",
            [],
            |row| row.get(0),
        )
        .map_err(|error| {
            format!("Could not inspect unresolved Notes image operation redo history: {error}")
        })?;
    if unresolved_redo {
        return Err("Notes history cannot prune an unacknowledged image operation.".to_string());
    }
    record_pruned_attachment_paths(
        transaction,
        "SELECT id FROM notes_history_entries WHERE is_undone = 1",
        [],
    )?;
    record_pruned_entry_ids(
        transaction,
        "SELECT id FROM notes_history_entries WHERE is_undone = 1 ORDER BY rowid, id",
        [],
    )?;
    transaction
        .execute(
            "DELETE FROM notes_image_atom_operations \
             WHERE operation_id IN (SELECT id FROM notes_history_entries WHERE is_undone = 1)",
            [],
        )
        .map_err(|error| {
            format!("Could not remove invalidated Notes image operation receipts: {error}")
        })?;
    transaction
        .execute("DELETE FROM notes_history_entries WHERE is_undone = 1", [])
        .map_err(|error| format!("Could not invalidate Notes redo history: {error}"))?;
    if !entry_exists {
        let sequence: i64 = transaction
            .query_row(
                "SELECT COALESCE(MAX(sequence), 0) + 1 FROM notes_history_entries WHERE session_id = ?1",
                [&context.0],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not allocate Notes history order: {error}"))?;
        transaction
            .execute(
                "INSERT INTO notes_history_entries(id, session_id, sequence, command_kind) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![context.1, context.0, sequence, context.2],
            )
            .map_err(|error| format!("Could not create Notes history entry: {error}"))?;
    }

    let base_ordinal: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(ordinal), 0) FROM notes_history_changes WHERE entry_id = ?1",
            [&context.1],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not inspect Notes history change order: {error}"))?;
    for (table_name, row_id, ordinal, before_json, after_json) in audit {
        transaction
            .execute(
                "INSERT INTO notes_history_changes(entry_id, table_name, row_id, ordinal, before_json, after_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
                 ON CONFLICT(entry_id, table_name, row_id) DO UPDATE SET after_json = excluded.after_json",
                params![context.1, table_name, row_id, base_ordinal + ordinal, before_json, after_json],
            )
            .map_err(|error| format!("Could not merge Notes history changes: {error}"))?;
    }
    transaction
        .execute(
            "DELETE FROM notes_history_changes WHERE entry_id = ?1 AND before_json IS after_json",
            [&context.1],
        )
        .map_err(|error| format!("Could not compact Notes history changes: {error}"))?;
    let change_count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM notes_history_changes WHERE entry_id = ?1",
            [&context.1],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not count Notes history changes: {error}"))?;
    if change_count == 0 {
        transaction
            .execute(
                "DELETE FROM notes_history_entries WHERE id = ?1",
                [&context.1],
            )
            .map_err(|error| format!("Could not remove empty Notes history entry: {error}"))?;
        return record_mutation_result(transaction, &context.0, &context.1);
    }
    transaction
        .execute(
            "UPDATE notes_history_entries SET estimated_bytes = (\
               SELECT COALESCE(SUM(\
                 length(CAST(COALESCE(before_json, '') AS BLOB)) + \
                 length(CAST(COALESCE(after_json, '') AS BLOB))\
               ), 0) FROM notes_history_changes WHERE entry_id = ?1\
             ) WHERE id = ?1",
            [&context.1],
        )
        .map_err(|error| format!("Could not estimate Notes history payload: {error}"))?;
    let current_entry_bytes: i64 = transaction
        .query_row(
            "SELECT estimated_bytes FROM notes_history_entries WHERE id = ?1",
            [&context.1],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not measure the new Notes history entry: {error}"))?;
    if current_entry_bytes > HISTORY_MAX_BYTES {
        return Err("A Notes history entry cannot exceed 50 MiB.".to_string());
    }
    enforce_limits(transaction, Some(&context.1))?;
    record_mutation_result(transaction, &context.0, &context.1)
}

fn record_mutation_result(
    transaction: &Transaction<'_>,
    session_id: &str,
    entry_id: &str,
) -> Result<(), String> {
    let history_entry_id = transaction
        .query_row(
            "SELECT id FROM notes_history_entries WHERE id = ?1 AND session_id = ?2",
            params![entry_id, session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not inspect the applied Notes history entry: {error}"))?;
    let status = history_status(transaction, session_id)?;
    transaction
        .execute("DELETE FROM notes_history_mutation_result", [])
        .and_then(|_| {
            transaction.execute(
                "INSERT INTO notes_history_mutation_result(\
                   history_entry_id, can_undo, can_redo\
                 ) VALUES (?1, ?2, ?3)",
                params![history_entry_id, status.can_undo, status.can_redo],
            )
        })
        .map_err(|error| {
            format!("Could not capture the committed Notes mutation result: {error}")
        })?;
    Ok(())
}

fn enforce_limits(
    transaction: &Transaction<'_>,
    protected_entry_id: Option<&str>,
) -> Result<(), String> {
    loop {
        let (entry_count, estimated_bytes): (i64, i64) = transaction
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(estimated_bytes), 0) FROM notes_history_entries",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| format!("Could not measure Notes history limits: {error}"))?;
        if entry_count <= HISTORY_MAX_ENTRIES && estimated_bytes <= HISTORY_MAX_BYTES {
            return Ok(());
        }
        let oldest_entry = transaction
            .query_row(
                "SELECT entry.id FROM notes_history_entries entry \
                 WHERE (?1 IS NULL OR entry.id <> ?1) \
                   AND NOT EXISTS(\
                     SELECT 1 FROM notes_image_atom_operations operation \
                     WHERE operation.operation_id = entry.id AND operation.acknowledged = 0\
                   ) \
                 ORDER BY entry.rowid, entry.id LIMIT 1",
                [protected_entry_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("Could not choose old Notes history to evict: {error}"))?
            .ok_or_else(|| "Could not enforce Notes history limits.".to_string())?;
        record_pruned_attachment_paths(transaction, "SELECT ?1", [&oldest_entry])?;
        record_pruned_entry_ids(transaction, "SELECT ?1", [&oldest_entry])?;
        transaction
            .execute(
                "DELETE FROM notes_image_atom_operations WHERE operation_id = ?1",
                [&oldest_entry],
            )
            .map_err(|error| {
                format!("Could not remove an evicted Notes image operation receipt: {error}")
            })?;
        let deleted = transaction
            .execute(
                "DELETE FROM notes_history_entries WHERE id = ?1",
                [&oldest_entry],
            )
            .map_err(|error| format!("Could not evict old Notes history: {error}"))?;
        if deleted == 0 {
            return Err("Could not enforce Notes history limits.".to_string());
        }
    }
}

pub(crate) fn history_status(
    connection: &Connection,
    session_id: &str,
) -> Result<NotesHistoryStatus, String> {
    history_state(connection, session_id, Vec::new())
}

#[cfg(test)]
pub(crate) fn clear_history(
    connection: &mut Connection,
    session_id: &str,
) -> Result<NotesHistoryStatus, String> {
    validate_history_id("Notes history session ID", session_id)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start clearing Notes history: {error}"))?;
    crate::notes::image_atom::clear_operation_receipts_for_session(&transaction, session_id)?;
    transaction
        .execute(
            "DELETE FROM notes_history_entries WHERE session_id = ?1",
            [session_id],
        )
        .map_err(|error| format!("Could not clear Notes history: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit cleared Notes history: {error}"))?;
    history_state(connection, session_id, Vec::new())
}

pub(crate) fn clear_all_history(connection: &mut Connection) -> Result<(), String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start expiring Notes history: {error}"))?;
    clear_all_history_in_transaction(&transaction)?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit expired Notes history: {error}"))
}

pub(crate) fn clear_all_history_in_transaction(
    transaction: &Transaction<'_>,
) -> Result<(), String> {
    crate::notes::image_atom::clear_operation_receipts(transaction)?;
    transaction
        .execute("DELETE FROM notes_history_entries", [])
        .map_err(|error| format!("Could not clear all Notes history: {error}"))?;
    Ok(())
}

#[derive(Debug)]
pub(crate) struct HistoryMaintenanceResult {
    pub(crate) state: NotesHistoryState,
    pub(crate) pruned_attachment_paths: Vec<String>,
}

fn clear_maintenance_receipts(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "DELETE FROM notes_history_pruned_attachment_paths; \
             DELETE FROM notes_history_pruned_entry_ids;",
        )
        .map_err(|error| format!("Could not clear Notes history maintenance state: {error}"))
}

fn validate_owned_entry_ids(
    connection: &Connection,
    session_id: &str,
    entry_ids: &[String],
) -> Result<(), String> {
    validate_history_id("Notes history session ID", session_id)?;
    let mut seen = HashSet::new();
    for entry_id in entry_ids {
        validate_history_id("Notes history entry ID", entry_id)?;
        if !seen.insert(entry_id) {
            return Err("Notes history entry IDs must not contain duplicates.".to_string());
        }
        let owner = connection
            .query_row(
                "SELECT session_id FROM notes_history_entries WHERE id = ?1",
                [entry_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("Could not inspect a Notes history entry owner: {error}"))?;
        if owner.as_deref() != Some(session_id) {
            return Err(
                "A Notes history entry is missing or belongs to another session.".to_string(),
            );
        }
    }
    Ok(())
}

fn prune_entry_ids(
    transaction: &Transaction<'_>,
    entry_ids: &[String],
) -> Result<Vec<String>, String> {
    for entry_id in entry_ids {
        let unresolved: bool = transaction
            .query_row(
                "SELECT EXISTS(\
                   SELECT 1 FROM notes_image_atom_operations \
                   WHERE operation_id = ?1 AND acknowledged = 0\
                 )",
                [entry_id],
                |row| row.get(0),
            )
            .map_err(|error| {
                format!("Could not inspect a Notes image operation receipt: {error}")
            })?;
        if unresolved {
            return Err(
                "Notes history cannot prune an unacknowledged image operation.".to_string(),
            );
        }
        record_pruned_attachment_paths(transaction, "SELECT ?1", [entry_id])?;
        transaction
            .execute(
                "DELETE FROM notes_image_atom_operations WHERE operation_id = ?1",
                [entry_id],
            )
            .map_err(|error| {
                format!("Could not remove a pruned Notes image operation receipt: {error}")
            })?;
        let deleted = transaction
            .execute(
                "DELETE FROM notes_history_entries WHERE id = ?1",
                [entry_id],
            )
            .map_err(|error| format!("Could not prune a Notes history entry: {error}"))?;
        if deleted != 1 {
            return Err("A Notes history entry disappeared while pruning.".to_string());
        }
    }
    Ok(entry_ids.to_vec())
}

pub(crate) fn prune_history_entries(
    connection: &mut Connection,
    input: &NotesPruneHistoryInput,
) -> Result<HistoryMaintenanceResult, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start pruning Notes history: {error}"))?;
    require_epoch(&transaction, &input.history_epoch)?;
    validate_owned_entry_ids(&transaction, &input.session_id, &input.entry_ids)?;
    clear_maintenance_receipts(&transaction)?;
    let pruned_entry_ids = prune_entry_ids(&transaction, &input.entry_ids)?;
    let state = history_state(&transaction, &input.session_id, pruned_entry_ids)?;
    let pruned_attachment_paths = take_pruned_attachment_paths(&transaction)?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit pruned Notes history: {error}"))?;
    Ok(HistoryMaintenanceResult {
        state,
        pruned_attachment_paths,
    })
}

pub(crate) fn close_all_history(
    connection: &mut Connection,
    session_id: &str,
    history_epoch: &str,
) -> Result<HistoryMaintenanceResult, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start closing Notes history: {error}"))?;
    validate_history_id("Notes history session ID", session_id)?;
    require_epoch(&transaction, history_epoch)?;
    crate::notes::image_atom::clear_operation_receipts(&transaction)?;
    clear_maintenance_receipts(&transaction)?;
    record_pruned_attachment_paths(
        &transaction,
        "SELECT id FROM notes_history_entries ORDER BY rowid, id",
        [],
    )?;
    let pruned_entry_ids = record_pruned_entry_ids(
        &transaction,
        "SELECT id FROM notes_history_entries ORDER BY rowid, id",
        [],
    )?;
    transaction
        .execute("DELETE FROM notes_history_entries", [])
        .map_err(|error| format!("Could not close Notes history: {error}"))?;
    let state = history_state(&transaction, session_id, pruned_entry_ids)?;
    let pruned_attachment_paths = take_pruned_attachment_paths(&transaction)?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit closing Notes history: {error}"))?;
    Ok(HistoryMaintenanceResult {
        state,
        pruned_attachment_paths,
    })
}

fn redo_suffix(connection: &Connection, session_id: &str) -> Result<Vec<String>, String> {
    validate_history_id("Notes history session ID", session_id)?;
    let mut statement = connection
        .prepare(
            "SELECT id FROM notes_history_entries \
             WHERE session_id = ?1 AND is_undone = 1 ORDER BY sequence ASC",
        )
        .map_err(|error| format!("Could not prepare the Notes redo suffix: {error}"))?;
    let suffix = statement
        .query_map([session_id], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Could not read the Notes redo suffix: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not collect the Notes redo suffix: {error}"))?;
    Ok(suffix)
}

pub(crate) fn prepare_navigation(
    connection: &mut Connection,
    input: &NotesPrepareNavigationInput,
) -> Result<HistoryMaintenanceResult, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not prepare Notes navigation: {error}"))?;
    require_epoch(&transaction, &input.history_epoch)?;
    validate_owned_entry_ids(
        &transaction,
        &input.session_id,
        &input.unreachable_redo_entry_ids,
    )?;
    let actual = redo_suffix(&transaction, &input.session_id)?;
    if actual != input.unreachable_redo_entry_ids {
        return Err(
            "Notes navigation must provide the complete ordered redo history suffix.".to_string(),
        );
    }
    clear_maintenance_receipts(&transaction)?;
    let pruned_entry_ids = prune_entry_ids(&transaction, &actual)?;
    let state = history_state(&transaction, &input.session_id, pruned_entry_ids)?;
    let pruned_attachment_paths = take_pruned_attachment_paths(&transaction)?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit Notes navigation preparation: {error}"))?;
    Ok(HistoryMaintenanceResult {
        state,
        pruned_attachment_paths,
    })
}

pub(crate) fn reset_history_in_transaction(
    transaction: &Transaction<'_>,
    input: &NotesHistoryResetInput,
) -> Result<HistoryMaintenanceResult, String> {
    validate_history_id("Notes history session ID", &input.session_id)?;
    require_epoch(transaction, &input.history_epoch)?;
    crate::notes::image_atom::clear_operation_receipts(transaction)?;
    clear_maintenance_receipts(transaction)?;
    record_pruned_attachment_paths(
        transaction,
        "SELECT id FROM notes_history_entries ORDER BY rowid, id",
        [],
    )?;
    let pruned_entry_ids = record_pruned_entry_ids(
        transaction,
        "SELECT id FROM notes_history_entries ORDER BY rowid, id",
        [],
    )?;
    transaction
        .execute("DELETE FROM notes_history_entries", [])
        .map_err(|error| format!("Could not reset Notes history: {error}"))?;
    transaction
        .execute("DELETE FROM notes_history_epoch", [])
        .and_then(|_| {
            transaction.execute(
                "INSERT INTO notes_history_epoch(value) VALUES (?1)",
                [Uuid::new_v4().to_string()],
            )
        })
        .map_err(|error| format!("Could not rotate the Notes history epoch: {error}"))?;
    let state = history_state(transaction, &input.session_id, pruned_entry_ids)?;
    let pruned_attachment_paths = take_pruned_attachment_paths(transaction)?;
    Ok(HistoryMaintenanceResult {
        state,
        pruned_attachment_paths,
    })
}

pub(crate) fn reset_history(
    connection: &mut Connection,
    input: &NotesHistoryResetInput,
) -> Result<(NotesWorkspace, HistoryMaintenanceResult), String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start resetting Notes history: {error}"))?;
    let result = reset_history_in_transaction(&transaction, input)?;
    let workspace = load_workspace(&transaction, NotesWorkspaceScope::Active)?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit reset Notes history: {error}"))?;
    Ok((workspace, result))
}

#[derive(Deserialize)]
struct NodeSnapshot {
    id: String,
    #[serde(rename = "nodeKind")]
    node_kind: NoteNodeKind,
    parent_id: Option<String>,
    sort_key: i64,
    title: String,
    note: String,
    image_offset_utf16: i64,
    layout_mode: String,
    is_collapsed: i64,
    is_starred: i64,
    completed_at: Option<String>,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
    deleted_batch_id: Option<String>,
    archived_at: Option<String>,
    archive_root_id: Option<String>,
    #[serde(default)]
    is_readonly: Option<i64>,
    #[serde(default)]
    plugin_state: Option<String>,
    #[serde(default)]
    plugin_meta: Option<String>,
}

#[derive(Deserialize)]
struct AttachmentSnapshot {
    id: String,
    node_id: String,
    sort_key: i64,
    relative_path: String,
    content_hash: String,
    original_name: String,
    mime_type: String,
    byte_size: i64,
    intrinsic_width: i64,
    intrinsic_height: i64,
    display_width: i64,
    created_at: String,
    updated_at: String,
}

impl From<AttachmentSnapshot> for NoteAttachment {
    fn from(attachment: AttachmentSnapshot) -> Self {
        Self {
            id: attachment.id,
            node_id: attachment.node_id,
            sort_key: attachment.sort_key,
            relative_path: attachment.relative_path,
            content_hash: attachment.content_hash,
            original_name: attachment.original_name,
            mime_type: attachment.mime_type,
            byte_size: attachment.byte_size,
            intrinsic_width: attachment.intrinsic_width,
            intrinsic_height: attachment.intrinsic_height,
            display_width: attachment.display_width,
            created_at: attachment.created_at,
            updated_at: attachment.updated_at,
        }
    }
}

fn decode_attachment_snapshot(row_id: &str, state: &str) -> Result<NoteAttachment, String> {
    let attachment: AttachmentSnapshot = serde_json::from_str(state)
        .map_err(|error| format!("Could not decode an attachment history row: {error}"))?;
    if attachment.id != row_id {
        return Err("A Notes attachment history row ID does not match its snapshot.".to_string());
    }
    Ok(attachment.into())
}

fn current_row_json(
    transaction: &Transaction<'_>,
    table_name: &str,
    row_id: &str,
) -> Result<Option<String>, String> {
    let has_plugin_storage: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('notes_nodes') WHERE name = 'is_readonly')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not inspect Notes history node storage: {error}"))?;
    let node_json = if has_plugin_storage {
        V3_NODE_JSON_NEW
    } else {
        NODE_JSON_NEW
    };
    let (table, alias, expression) = match table_name {
        "notes_nodes" => (
            "notes_nodes",
            "node",
            node_json.replace("NEW.", "node."),
        ),
        "notes_attachments" => (
            "notes_attachments",
            "attachment",
            ATTACHMENT_JSON_NEW.replace("NEW.", "attachment."),
        ),
        _ => return Err(format!("Unsupported Notes history table {table_name}.")),
    };
    transaction
        .query_row(
            &format!("SELECT {expression} FROM {table} {alias} WHERE {alias}.id = ?1"),
            [row_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not inspect {table_name} row {row_id}: {error}"))
}

fn validate_expected_states(
    transaction: &Transaction<'_>,
    changes: &[(String, String, Option<String>, Option<String>)],
    undoing: bool,
) -> Result<(), String> {
    for (table_name, row_id, before_json, after_json) in changes {
        let expected = if undoing { after_json } else { before_json };
        let current = current_row_json(transaction, table_name, row_id)?;
        if current.as_deref() != expected.as_deref() {
            return Err(format!(
                "Notes history conflict: {table_name} row {row_id} no longer matches the expected state."
            ));
        }
    }
    Ok(())
}

fn decode_node_snapshot(row_id: &str, state: &str) -> Result<NodeSnapshot, String> {
    let node: NodeSnapshot = serde_json::from_str(state)
        .map_err(|error| format!("Could not decode a Note history row: {error}"))?;
    if node.id != row_id {
        return Err("A Notes history row ID does not match its snapshot.".to_string());
    }
    if node.is_readonly.is_some_and(|value| !matches!(value, 0 | 1)) {
        return Err("Unsupported Notes readonly value in history.".to_string());
    }
    Ok(node)
}

fn node_is_live(node: &NodeSnapshot) -> bool {
    node.deleted_at.is_none() && node.archived_at.is_none()
}

fn validate_target_lifecycle(
    transaction: &Transaction<'_>,
    changes: &[(String, String, Option<String>, Option<String>)],
    undoing: bool,
) -> Result<(), String> {
    #[derive(Debug)]
    struct LifecycleState {
        parent_id: Option<String>,
        is_live: bool,
    }

    let mut resulting_nodes = {
        let mut statement = transaction
            .prepare(
                "SELECT id, parent_id, deleted_at IS NULL AND archived_at IS NULL FROM notes_nodes",
            )
            .map_err(|error| format!("Could not prepare Notes hierarchy validation: {error}"))?;
        let nodes = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    LifecycleState {
                        parent_id: row.get(1)?,
                        is_live: row.get(2)?,
                    },
                ))
            })
            .map_err(|error| format!("Could not read Notes hierarchy validation: {error}"))?
            .collect::<Result<HashMap<_, _>, _>>()
            .map_err(|error| format!("Could not collect Notes hierarchy validation: {error}"))?;
        nodes
    };
    for (table_name, row_id, before_json, after_json) in changes {
        if table_name != "notes_nodes" {
            continue;
        }
        let target = if undoing { before_json } else { after_json };
        match target.as_deref() {
            Some(state) => {
                let node = decode_node_snapshot(row_id, state)?;
                let is_live = node_is_live(&node);
                resulting_nodes.insert(
                    row_id.clone(),
                    LifecycleState {
                        parent_id: node.parent_id,
                        is_live,
                    },
                );
            }
            None => {
                resulting_nodes.remove(row_id);
            }
        }
    }

    for (row_id, node) in &resulting_nodes {
        if !node.is_live {
            continue;
        }
        let Some(parent_id) = node.parent_id.as_deref() else {
            continue;
        };
        let parent_is_live = resulting_nodes
            .get(parent_id)
            .is_some_and(|parent| parent.is_live);
        if !parent_is_live {
            return Err(format!(
                "Notes history conflict: replaying live node {row_id} would place it under inactive parent {parent_id}."
            ));
        }
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum VisitColor {
        Visiting,
        Visited,
    }

    // Persisted hierarchy must remain acyclic even for deleted or archived nodes.
    let mut colors = HashMap::<&str, VisitColor>::with_capacity(resulting_nodes.len());
    for start in resulting_nodes.keys() {
        if colors.contains_key(start.as_str()) {
            continue;
        }
        let mut walk = Vec::new();
        let mut current = start.as_str();
        loop {
            match colors.get(current).copied() {
                Some(VisitColor::Visiting) => {
                    return Err(
                        "Notes history conflict: replay would create a cycle in the Notes hierarchy."
                            .to_string(),
                    );
                }
                Some(VisitColor::Visited) => break,
                None => {
                    colors.insert(current, VisitColor::Visiting);
                    walk.push(current);
                }
            }
            let Some(parent_id) = resulting_nodes
                .get(current)
                .and_then(|node| node.parent_id.as_deref())
            else {
                break;
            };
            if !resulting_nodes.contains_key(parent_id) {
                break;
            }
            current = parent_id;
        }
        for node_id in walk {
            colors.insert(node_id, VisitColor::Visited);
        }
    }
    Ok(())
}

fn validate_target_attachment_capacity(
    transaction: &Transaction<'_>,
    changes: &[(String, String, Option<String>, Option<String>)],
    undoing: bool,
) -> Result<(), String> {
    if !changes
        .iter()
        .any(|(table_name, _, _, _)| table_name == "notes_attachments")
    {
        return Ok(());
    }

    let mut resulting_attachments = {
        let mut statement = transaction
            .prepare("SELECT id, node_id FROM notes_attachments")
            .map_err(|error| {
                format!("Could not prepare Notes attachment capacity replay: {error}")
            })?;
        let attachments = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("Could not read Notes attachment capacity replay: {error}"))?
            .collect::<Result<HashMap<_, _>, _>>()
            .map_err(|error| {
                format!("Could not collect Notes attachment capacity replay: {error}")
            })?;
        attachments
    };

    for (table_name, row_id, before_json, after_json) in changes {
        if table_name != "notes_attachments" {
            continue;
        }
        let target = if undoing { before_json } else { after_json };
        match target.as_deref() {
            Some(state) => {
                let attachment = decode_attachment_snapshot(row_id, state)?;
                resulting_attachments.insert(row_id.clone(), attachment.node_id);
            }
            None => {
                resulting_attachments.remove(row_id);
            }
        }
    }

    let mut per_node_counts = HashMap::<String, i64>::new();
    for node_id in resulting_attachments.values() {
        *per_node_counts.entry(node_id.clone()).or_default() += 1;
    }
    if per_node_counts
        .values()
        .any(|count| *count > MAX_NOTE_ATTACHMENTS_PER_NODE)
    {
        return Err(format!(
            "A Note node can contain at most {MAX_NOTE_ATTACHMENTS_PER_NODE} attachments."
        ));
    }
    let vault_count = i64::try_from(resulting_attachments.len())
        .map_err(|_| "Could not measure Notes attachment capacity replay.".to_string())?;
    if vault_count > MAX_NOTE_ATTACHMENTS_PER_VAULT {
        return Err(format!(
            "A Notes vault can contain at most {MAX_NOTE_ATTACHMENTS_PER_VAULT} attachments."
        ));
    }
    Ok(())
}

fn validate_target_image_attachment_ownership(
    transaction: &Transaction<'_>,
    changes: &[(String, String, Option<String>, Option<String>)],
    undoing: bool,
) -> Result<(), String> {
    let node_rows = transaction
        .prepare("SELECT id, node_kind FROM notes_nodes")
        .map_err(|error| format!("Could not prepare image ownership replay: {error}"))?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Could not read image ownership replay: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not collect image ownership replay: {error}"))?;
    let mut resulting_node_kinds = HashMap::<String, NoteNodeKind>::new();
    for (node_id, node_kind) in node_rows {
        let node_kind = match node_kind.as_str() {
            "text" => NoteNodeKind::Text,
            "image" => NoteNodeKind::Image,
            _ => {
                return Err(format!(
                    "Notes history conflict: node {node_id} has unsupported kind {node_kind}."
                ));
            }
        };
        resulting_node_kinds.insert(node_id, node_kind);
    }

    let mut resulting_attachments = transaction
        .prepare("SELECT id, node_id FROM notes_attachments")
        .map_err(|error| format!("Could not prepare image attachment replay: {error}"))?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Could not read image attachment replay: {error}"))?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(|error| format!("Could not collect image attachment replay: {error}"))?;
    let mut affected_node_ids = HashSet::<String>::new();

    for (table_name, row_id, before_json, after_json) in changes {
        let target = if undoing { before_json } else { after_json };
        match table_name.as_str() {
            "notes_nodes" => {
                if resulting_node_kinds.get(row_id) == Some(&NoteNodeKind::Image) {
                    affected_node_ids.insert(row_id.clone());
                }
                match target.as_deref() {
                    Some(state) => {
                        let node = decode_node_snapshot(row_id, state)?;
                        if node.node_kind == NoteNodeKind::Image {
                            affected_node_ids.insert(row_id.clone());
                        }
                        resulting_node_kinds.insert(row_id.clone(), node.node_kind);
                    }
                    None => {
                        resulting_node_kinds.remove(row_id);
                    }
                }
            }
            "notes_attachments" => {
                if let Some(current_node_id) = resulting_attachments.get(row_id) {
                    affected_node_ids.insert(current_node_id.clone());
                }
                match target.as_deref() {
                    Some(state) => {
                        let attachment = decode_attachment_snapshot(row_id, state)?;
                        affected_node_ids.insert(attachment.node_id.clone());
                        resulting_attachments.insert(row_id.clone(), attachment.node_id);
                    }
                    None => {
                        resulting_attachments.remove(row_id);
                    }
                }
            }
            _ => return Err(format!("Unsupported Notes history table {table_name}.")),
        }
    }

    let mut attachment_counts = HashMap::<String, usize>::new();
    for (attachment_id, node_id) in &resulting_attachments {
        if !resulting_node_kinds.contains_key(node_id) {
            return Err(format!(
                "Notes history conflict: attachment {attachment_id} has missing owner node {node_id}."
            ));
        }
        *attachment_counts.entry(node_id.clone()).or_default() += 1;
    }
    for node_id in affected_node_ids {
        if resulting_node_kinds.get(&node_id) != Some(&NoteNodeKind::Image) {
            continue;
        }
        let count = attachment_counts.get(&node_id).copied().unwrap_or_default();
        if count != 1 {
            return Err(format!(
                "Notes history conflict: image node {node_id} must own exactly one attachment; found {count}."
            ));
        }
    }
    Ok(())
}

fn validate_target_id_namespace(
    transaction: &Transaction<'_>,
    changes: &[(String, String, Option<String>, Option<String>)],
    undoing: bool,
) -> Result<(), String> {
    let mut node_ids = transaction
        .prepare("SELECT id FROM notes_nodes")
        .map_err(|error| format!("Could not prepare Notes node ID replay validation: {error}"))?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Could not read Notes node IDs for replay: {error}"))?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|error| format!("Could not collect Notes node IDs for replay: {error}"))?;
    let mut attachment_ids = transaction
        .prepare("SELECT id FROM notes_attachments")
        .map_err(|error| {
            format!("Could not prepare Notes attachment ID replay validation: {error}")
        })?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Could not read Notes attachment IDs for replay: {error}"))?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|error| format!("Could not collect Notes attachment IDs for replay: {error}"))?;

    for (table_name, row_id, before_json, after_json) in changes {
        let state = if undoing { before_json } else { after_json };
        let ids = match table_name.as_str() {
            "notes_nodes" => &mut node_ids,
            "notes_attachments" => &mut attachment_ids,
            _ => return Err(format!("Unsupported Notes history table {table_name}.")),
        };
        if state.is_some() {
            ids.insert(row_id.clone());
        } else {
            ids.remove(row_id);
        }
    }

    if let Some(id) = node_ids.intersection(&attachment_ids).next() {
        return Err(format!(
            "Notes history conflict: the resulting ID namespace uses {id} for both a node and attachment."
        ));
    }
    Ok(())
}

fn apply_node_state(
    transaction: &Transaction<'_>,
    row_id: &str,
    state: Option<&str>,
) -> Result<(), String> {
    let Some(state) = state else {
        record_history_hard_delete_sync_evidence(transaction, row_id)?;
        transaction
            .execute("DELETE FROM notes_nodes WHERE id = ?1", [row_id])
            .map_err(|error| {
                format!("Could not remove a Note row during history replay: {error}")
            })?;
        return Ok(());
    };
    let node = decode_node_snapshot(row_id, state)?;
    let current_is_active: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_nodes \
             WHERE id = ?1 AND deleted_at IS NULL AND archived_at IS NULL)",
            [row_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not inspect a replayed Notes move: {error}"))?;
    if current_is_active && node.deleted_at.is_none() && node.archived_at.is_none() {
        crate::notes::repository::mark_former_topic_dirty_for_move(
            transaction,
            row_id,
            node.parent_id.as_deref(),
        )?;
    }
    if transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('notes_nodes') WHERE name = 'is_readonly')",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("Could not inspect Notes history node storage: {error}"))?
    {
        transaction
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, note, image_offset_utf16, layout_mode, is_collapsed, is_starred, \
                   completed_at, created_at, updated_at, deleted_at, deleted_batch_id, archived_at, \
                   archive_root_id, node_kind, is_readonly, plugin_state, plugin_meta\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20) \
                 ON CONFLICT(id) DO UPDATE SET \
                   parent_id = excluded.parent_id, sort_key = excluded.sort_key, title = excluded.title, \
                   note = excluded.note, image_offset_utf16 = excluded.image_offset_utf16, \
                   layout_mode = excluded.layout_mode, is_collapsed = excluded.is_collapsed, \
                   is_starred = excluded.is_starred, completed_at = excluded.completed_at, \
                   created_at = excluded.created_at, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, \
                   deleted_batch_id = excluded.deleted_batch_id, archived_at = excluded.archived_at, \
                   archive_root_id = excluded.archive_root_id, node_kind = excluded.node_kind, \
                   is_readonly = excluded.is_readonly, plugin_state = excluded.plugin_state, plugin_meta = excluded.plugin_meta",
                params![
                    node.id, node.parent_id, node.sort_key, node.title, node.note,
                    node.image_offset_utf16, node.layout_mode, node.is_collapsed, node.is_starred,
                    node.completed_at, node.created_at, node.updated_at, node.deleted_at,
                    node.deleted_batch_id, node.archived_at, node.archive_root_id, node.node_kind.as_str(),
                    node.is_readonly, node.plugin_state, node.plugin_meta,
                ],
            )
            .map_err(|error| format!("Could not restore a Note row during history replay: {error}"))?;
    } else {
        transaction
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, note, image_offset_utf16, layout_mode, is_collapsed, is_starred, \
                   completed_at, created_at, updated_at, deleted_at, deleted_batch_id, archived_at, archive_root_id, node_kind\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17) \
                 ON CONFLICT(id) DO UPDATE SET \
                   parent_id = excluded.parent_id, sort_key = excluded.sort_key, title = excluded.title, \
                   note = excluded.note, image_offset_utf16 = excluded.image_offset_utf16, \
                   layout_mode = excluded.layout_mode, is_collapsed = excluded.is_collapsed, \
                   is_starred = excluded.is_starred, completed_at = excluded.completed_at, \
                   created_at = excluded.created_at, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, \
                   deleted_batch_id = excluded.deleted_batch_id, archived_at = excluded.archived_at, \
                   archive_root_id = excluded.archive_root_id, node_kind = excluded.node_kind",
                params![
                    node.id, node.parent_id, node.sort_key, node.title, node.note,
                    node.image_offset_utf16, node.layout_mode, node.is_collapsed, node.is_starred,
                    node.completed_at, node.created_at, node.updated_at, node.deleted_at,
                    node.deleted_batch_id, node.archived_at, node.archive_root_id, node.node_kind.as_str()
                ],
            )
            .map_err(|error| format!("Could not restore a Note row during history replay: {error}"))?;
    }
    Ok(())
}

fn record_history_hard_delete_sync_evidence(
    transaction: &Transaction<'_>,
    node_id: &str,
) -> Result<(), String> {
    let former_topic = transaction
        .query_row(
            "WITH RECURSIVE ancestors(id, parent_id, depth) AS (\
               SELECT id, parent_id, 0 FROM notes_nodes WHERE id = ?1 \
               UNION ALL \
               SELECT parent.id, parent.parent_id, ancestors.depth + 1 \
               FROM notes_nodes parent JOIN ancestors ON ancestors.parent_id = parent.id \
               WHERE ancestors.depth < 10000\
             ) \
             SELECT id FROM ancestors WHERE parent_id IS NULL \
             ORDER BY depth DESC LIMIT 1",
            [node_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not resolve a history-deleted Notes topic: {error}"))?;
    crate::notes::sync::record_purged_node_ids(transaction, &[node_id])?;
    if let Some(topic_id) = former_topic {
        transaction
            .execute(
                "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1) \
                 ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at",
                [topic_id],
            )
            .map_err(|error| format!("Could not dirty a history-deleted Notes topic: {error}"))?;
    }
    transaction
        .execute(
            "INSERT INTO sync_dirty_nodes(node_id) VALUES ('__yonalist_trash__') \
             ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at",
            [],
        )
        .map_err(|error| format!("Could not dirty Notes trash for history replay: {error}"))?;
    Ok(())
}

fn apply_attachment_state(
    transaction: &Transaction<'_>,
    row_id: &str,
    state: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(state) = state else {
        let node_id = transaction
            .query_row(
                "SELECT node_id FROM notes_attachments WHERE id = ?1",
                [row_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| {
                format!("Could not inspect an attachment during history replay: {error}")
            })?;
        transaction
            .execute("DELETE FROM notes_attachments WHERE id = ?1", [row_id])
            .map_err(|error| {
                format!("Could not remove an attachment during history replay: {error}")
            })?;
        return Ok(node_id);
    };
    let attachment = decode_attachment_snapshot(row_id, state)?;
    let node_id = attachment.node_id.clone();
    transaction
        .execute(
            "INSERT INTO notes_attachments(\
               id, node_id, sort_key, relative_path, content_hash, original_name, mime_type, \
               byte_size, intrinsic_width, intrinsic_height, display_width, created_at, updated_at\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) \
             ON CONFLICT(id) DO UPDATE SET \
               node_id = excluded.node_id, sort_key = excluded.sort_key, relative_path = excluded.relative_path, \
               content_hash = excluded.content_hash, original_name = excluded.original_name, \
               mime_type = excluded.mime_type, byte_size = excluded.byte_size, \
               intrinsic_width = excluded.intrinsic_width, intrinsic_height = excluded.intrinsic_height, \
               display_width = excluded.display_width, created_at = excluded.created_at, updated_at = excluded.updated_at",
            params![
                attachment.id, attachment.node_id, attachment.sort_key, attachment.relative_path,
                attachment.content_hash, attachment.original_name, attachment.mime_type,
                attachment.byte_size, attachment.intrinsic_width, attachment.intrinsic_height,
                attachment.display_width, attachment.created_at, attachment.updated_at
            ],
        )
        .map_err(|error| format!("Could not restore an attachment during history replay: {error}"))?;
    Ok(Some(node_id))
}

/// Chooses the history entry a replay will advance. Accepts anything that
/// derefs to a `Connection` (a plain connection for the pre-transaction
/// attachment check, or a `&Transaction` inside the replay transaction).
#[cfg(test)]
fn select_replay_entry_id(
    executor: &Connection,
    session_id: &str,
    undoing: bool,
) -> Result<Option<String>, String> {
    executor
        .query_row(
            if undoing {
                "SELECT id FROM notes_history_entries WHERE session_id = ?1 AND is_undone = 0 ORDER BY sequence DESC LIMIT 1"
            } else {
                "SELECT id FROM notes_history_entries WHERE session_id = ?1 AND is_undone = 1 ORDER BY sequence ASC LIMIT 1"
            },
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not choose a Notes history entry: {error}"))
}

/// Reads the audit change rows for a history entry in replay order.
fn read_replay_changes(
    executor: &Connection,
    entry_id: &str,
    undoing: bool,
) -> Result<Vec<(String, String, Option<String>, Option<String>)>, String> {
    let order = if undoing { "DESC" } else { "ASC" };
    let mut statement = executor
        .prepare(&format!(
            "SELECT table_name, row_id, before_json, after_json FROM notes_history_changes WHERE entry_id = ?1 ORDER BY ordinal {order}"
        ))
        .map_err(|error| format!("Could not prepare Notes history replay: {error}"))?;
    let changes = statement
        .query_map([entry_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|error| format!("Could not read Notes history replay: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not collect Notes history replay: {error}"))?;
    Ok(changes)
}

/// Re-reads the owned bytes for every attachment the replay would touch and
/// SHA-256-verifies them against their stored content hash, confirming the
/// files are still intact. Runs outside the replay transaction so the file read
/// never holds the write lock (mirrors the PreparedAttachmentBatch
/// pre-transaction check).
fn validate_replay_attachment_bytes(
    storage: &AttachmentStorageLease,
    changes: &[(String, String, Option<String>, Option<String>)],
    undoing: bool,
) -> Result<Vec<NoteAttachment>, String> {
    let mut attachments = Vec::new();
    for (table_name, row_id, before_json, after_json) in changes {
        if table_name != "notes_attachments" {
            continue;
        }
        let target = if undoing { before_json } else { after_json };
        if let Some(state) = target {
            let attachment = decode_attachment_snapshot(row_id, state)?;
            crate::notes::sync::asset_gc::validate_attachment_for_replay(storage, &attachment)
                .map_err(|error| {
                    format!("Could not validate a Notes attachment for history replay: {error}")
                })?;
            attachments.push(attachment);
        }
    }
    Ok(attachments)
}

enum ReplayGate {
    Apply(String),
    EpochMismatch(NotesHistoryState),
    EntryMissing(NotesHistoryState),
    EntryNotNext(NotesHistoryState),
}

fn expected_replay_entry(
    connection: &Connection,
    session_id: &str,
    expected_epoch: &str,
    expected_entry_id: &str,
    undoing: bool,
) -> Result<ReplayGate, String> {
    let state = history_state(connection, session_id, Vec::new())?;
    if state.history_epoch != expected_epoch {
        return Ok(ReplayGate::EpochMismatch(state));
    }
    let next = if undoing {
        state.next_undo_entry_id.clone()
    } else {
        state.next_redo_entry_id.clone()
    };
    let Some(next) = next else {
        return Ok(ReplayGate::EntryMissing(state));
    };
    if next != expected_entry_id {
        return Ok(ReplayGate::EntryNotNext(state));
    }
    Ok(ReplayGate::Apply(next))
}

fn replay_outcome(gate: ReplayGate) -> Option<NotesHistoryReplayOutcome> {
    match gate {
        ReplayGate::Apply(_) => None,
        ReplayGate::EpochMismatch(state) => {
            Some(NotesHistoryReplayOutcome::EpochMismatch { state })
        }
        ReplayGate::EntryMissing(state) => Some(NotesHistoryReplayOutcome::EntryMissing { state }),
        ReplayGate::EntryNotNext(state) => Some(NotesHistoryReplayOutcome::EntryNotNext { state }),
    }
}

fn replay_expected(
    connection: &mut Connection,
    session_id: &str,
    expected_epoch: &str,
    expected_entry_id: &str,
    scope: NotesWorkspaceScope,
    undoing: bool,
    attachment_storage: Option<&AttachmentStorageLease>,
    today: LocalDate,
) -> Result<NotesHistoryReplayOutcome, String> {
    let gate = expected_replay_entry(
        connection,
        session_id,
        expected_epoch,
        expected_entry_id,
        undoing,
    )?;
    if let Some(outcome) = replay_outcome(gate) {
        return Ok(outcome);
    }

    // Re-decode every touched attachment's owned bytes BEFORE opening the write
    // transaction. Doing this inside the IMMEDIATE transaction (as before) held
    // the write lock across a full image decode of each attachment; instead we
    // validate against the current, serialized snapshot first — the same entry
    // and change set the transaction below re-reads (note commands are
    // serialized per vault on a single managed connection).
    let replay_attachments = if let Some(storage) = attachment_storage {
        let changes = read_replay_changes(connection, expected_entry_id, undoing)?;
        validate_replay_attachment_bytes(storage, &changes, undoing)?
    } else {
        Vec::new()
    };

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start Notes history replay: {error}"))?;
    let gate = expected_replay_entry(
        &transaction,
        session_id,
        expected_epoch,
        expected_entry_id,
        undoing,
    )?;
    let entry_id = match gate {
        ReplayGate::Apply(entry_id) => entry_id,
        gate => {
            let outcome = replay_outcome(gate).expect("non-apply replay gate");
            transaction.commit().map_err(|error| {
                format!("Could not finish rejected Notes history replay: {error}")
            })?;
            return Ok(outcome);
        }
    };
    let changes = read_replay_changes(&transaction, &entry_id, undoing)?;
    validate_expected_states(&transaction, &changes, undoing)?;
    validate_target_lifecycle(&transaction, &changes, undoing)?;
    validate_target_attachment_capacity(&transaction, &changes, undoing)?;
    validate_target_image_attachment_ownership(&transaction, &changes, undoing)?;
    validate_target_id_namespace(&transaction, &changes, undoing)?;
    let mut affected_nodes = BTreeSet::new();
    for (table_name, row_id, before_json, after_json) in changes {
        let state = if undoing {
            before_json.as_deref()
        } else {
            after_json.as_deref()
        };
        match table_name.as_str() {
            "notes_nodes" => {
                affected_nodes.insert(row_id.clone());
                apply_node_state(&transaction, &row_id, state)?;
            }
            "notes_attachments" => {
                if let Some(node_id) = apply_attachment_state(&transaction, &row_id, state)? {
                    affected_nodes.insert(node_id);
                }
            }
            _ => return Err(format!("Unsupported Notes history table {table_name}.")),
        }
    }
    rebuild_derived_for_nodes_at(&transaction, &affected_nodes, today)?;
    transaction
        .execute(
            "UPDATE notes_history_entries SET is_undone = ?1 WHERE id = ?2",
            params![undoing, entry_id],
        )
        .map_err(|error| format!("Could not advance Notes history replay: {error}"))?;
    let workspace = load_workspace(&transaction, scope)?;
    let state = history_state(&transaction, session_id, Vec::new())?;
    let mut staged_attachments = Vec::new();
    if let Some(storage) = attachment_storage {
        for attachment in &replay_attachments {
            match crate::notes::sync::asset_gc::restore_attachment_for_replay(
                &transaction,
                storage,
                attachment,
            ) {
                Ok(stage) => {
                    staged_attachments.push(stage);
                }
                Err(error) => {
                    let mut errors = vec![format!(
                        "Could not stage a Notes attachment for history replay: {error}"
                    )];
                    while let Some(stage) = staged_attachments.pop() {
                        if let Err(rollback) =
                            crate::notes::sync::asset_gc::rollback_attachment_for_replay(
                                storage, stage,
                            )
                        {
                            errors.push(format!(
                                "Could not roll back a staged Notes replay attachment: {rollback}"
                            ));
                        }
                    }
                    return Err(errors.join(" "));
                }
            }
        }
    }
    if let Err(error) = transaction.commit() {
        let mut errors = vec![format!("Could not commit Notes history replay: {error}")];
        if let Some(storage) = attachment_storage {
            while let Some(stage) = staged_attachments.pop() {
                if let Err(rollback) =
                    crate::notes::sync::asset_gc::rollback_attachment_for_replay(storage, stage)
                {
                    errors.push(format!(
                        "Could not roll back a staged Notes replay attachment: {rollback}"
                    ));
                }
            }
        }
        return Err(errors.join(" "));
    }
    if let Some(storage) = attachment_storage {
        for stage in staged_attachments {
            if let Err(error) =
                crate::notes::sync::asset_gc::finalize_attachment_for_replay(storage, stage)
            {
                eprintln!("Notes attachment replay cleanup warning: {error}");
            }
        }
    }
    Ok(NotesHistoryReplayOutcome::Applied {
        workspace,
        replayed_entry_id: entry_id,
        state,
    })
}

#[cfg(test)]
fn replay_automatic(
    connection: &mut Connection,
    session_id: &str,
    scope: NotesWorkspaceScope,
    undoing: bool,
    today: LocalDate,
) -> Result<NotesHistoryReplayResult, String> {
    let Some(entry_id) = select_replay_entry_id(connection, session_id, undoing)? else {
        return Ok(NotesHistoryReplayResult {
            workspace: load_workspace(connection, scope)?,
            replayed_entry_id: None,
            state: history_state(connection, session_id, Vec::new())?,
        });
    };
    let epoch = history_epoch(connection)?;
    match replay_expected(
        connection, session_id, &epoch, &entry_id, scope, undoing, None, today,
    )? {
        NotesHistoryReplayOutcome::Applied {
            workspace,
            replayed_entry_id,
            state,
        } => Ok(NotesHistoryReplayResult {
            workspace,
            replayed_entry_id: Some(replayed_entry_id),
            state,
        }),
        _ => Err("Automatic Notes history replay was unexpectedly rejected.".to_string()),
    }
}

#[cfg(test)]
pub(crate) fn undo(
    connection: &mut Connection,
    session_id: &str,
    scope: NotesWorkspaceScope,
) -> Result<NotesHistoryReplayResult, String> {
    let today = SystemLocalTodayProvider.local_today(connection)?;
    replay_automatic(connection, session_id, scope, true, today)
}

#[cfg(test)]
pub(crate) fn redo(
    connection: &mut Connection,
    session_id: &str,
    scope: NotesWorkspaceScope,
) -> Result<NotesHistoryReplayResult, String> {
    let today = SystemLocalTodayProvider.local_today(connection)?;
    replay_automatic(connection, session_id, scope, false, today)
}

#[cfg(test)]
pub(crate) fn undo_expected(
    connection: &mut Connection,
    session_id: &str,
    expected_epoch: &str,
    expected_entry_id: &str,
    scope: NotesWorkspaceScope,
) -> Result<NotesHistoryReplayOutcome, String> {
    let today = SystemLocalTodayProvider.local_today(connection)?;
    replay_expected(
        connection,
        session_id,
        expected_epoch,
        expected_entry_id,
        scope,
        true,
        None,
        today,
    )
}

pub(crate) fn undo_with_attachment_storage_at(
    connection: &mut Connection,
    session_id: &str,
    expected_epoch: &str,
    expected_entry_id: &str,
    scope: NotesWorkspaceScope,
    attachment_storage: &AttachmentStorageLease,
    today: LocalDate,
) -> Result<NotesHistoryReplayOutcome, String> {
    replay_expected(
        connection,
        session_id,
        expected_epoch,
        expected_entry_id,
        scope,
        true,
        Some(attachment_storage),
        today,
    )
}

pub(crate) fn redo_with_attachment_storage_at(
    connection: &mut Connection,
    session_id: &str,
    expected_epoch: &str,
    expected_entry_id: &str,
    scope: NotesWorkspaceScope,
    attachment_storage: &AttachmentStorageLease,
    today: LocalDate,
) -> Result<NotesHistoryReplayOutcome, String> {
    replay_expected(
        connection,
        session_id,
        expected_epoch,
        expected_entry_id,
        scope,
        false,
        Some(attachment_storage),
        today,
    )
}

#[cfg(test)]
mod tests {
    use super::{
        clear_history, close_all_history, enforce_limits, history_epoch, history_state,
        history_status, prepare_navigation, prune_history_entries, redo, reset_history, undo,
        undo_expected, with_history_transaction, with_history_transaction_and_prunes,
        HISTORY_MAX_BYTES, HISTORY_MAX_ENTRIES, V3_NODE_JSON_NEW, V3_NODE_JSON_OLD,
    };
    use crate::notes::repository::{
        apply_batch, archive_node, connect_notes_db, create_attachment,
        create_attachments_coordinated_for_node, create_image_nodes_coordinated, create_node,
        delete_database, duplicate_node, empty_trash, list_tags, load_workspace, move_node,
        remove_attachment, resize_attachment, restore_node, search_nodes, search_nodes_structured,
        soft_delete_node, split_node, toggle_collapsed, toggle_complete, toggle_star,
        unarchive_node, update_node, NewAttachment, NewImageNode,
    };
    use crate::notes::types::{
        ApplyBatchInput, BatchOp, CreateNodeInput, ImageAtomFocusResult,
        ImageAtomOperationReceiptResult, MoveNodeInput, NoteSearchTag, NoteStructuredSearchQuery,
        NoteTagPrefix, NotesHistoryContext, NotesHistoryReplayOutcome, NotesMutationResult,
        NotesPrepareNavigationInput, NotesPruneHistoryInput, NotesWorkspace, NotesWorkspaceScope,
        SplitNodeInput, UpdateNodeInput, MAX_NOTE_ATTACHMENTS_PER_NODE,
        MAX_NOTE_ATTACHMENTS_PER_VAULT,
    };
    use rusqlite::{params, Connection, TransactionBehavior};

    const NODE_ID: &str = "11111111-1111-4111-8111-111111111111";
    const CHILD_ID: &str = "22222222-2222-4222-8222-222222222222";
    const THIRD_ID: &str = "33333333-3333-4333-8333-333333333333";
    const SESSION_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const SECOND_SESSION_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    #[test]
    fn dormant_v3_history_node_projections_include_plugin_storage_fields() {
        for projection in [V3_NODE_JSON_NEW, V3_NODE_JSON_OLD] {
            for field in ["is_readonly", "plugin_state", "plugin_meta"] {
                assert!(projection.contains(&format!("'{field}'")));
                assert!(projection.contains(&format!(".{field}")));
            }
        }
        assert!(!super::NODE_JSON_NEW.contains("'is_readonly'"));
        assert!(!super::NODE_JSON_OLD.contains("'is_readonly'"));
    }

    fn history_context(index: usize, command_kind: &str) -> NotesHistoryContext {
        history_context_for_session(SESSION_ID, index, command_kind)
    }

    fn history_context_for_session(
        session_id: &str,
        index: usize,
        command_kind: &str,
    ) -> NotesHistoryContext {
        NotesHistoryContext {
            session_id: session_id.to_string(),
            history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
            entry_id: format!("00000000-0000-4000-8000-{index:012x}"),
            command_kind: command_kind.to_string(),
        }
    }

    fn create_input(
        id: &str,
        parent_id: Option<&str>,
        after_id: Option<&str>,
        title: &str,
    ) -> CreateNodeInput {
        CreateNodeInput {
            id: id.to_string(),
            parent_id: parent_id.map(str::to_string),
            after_id: after_id.map(str::to_string),
            title: title.to_string(),
            note: String::new(),
        }
    }

    fn active(connection: &Connection) -> NotesWorkspace {
        load_workspace(connection, NotesWorkspaceScope::Active).expect("active workspace")
    }

    fn journal(
        connection: &mut Connection,
        context: &NotesHistoryContext,
        operation: impl FnOnce(&mut Connection) -> Result<NotesWorkspace, String>,
    ) -> Result<NotesWorkspace, String> {
        with_history_transaction(connection, Some(context), operation)
    }

    fn entry_count(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT COUNT(*) FROM notes_history_entries", [], |row| {
                row.get(0)
            })
            .expect("history entry count")
    }

    fn connect_empty_history_db(vault_path: &str) -> Connection {
        let connection = connect_notes_db(vault_path).expect("connect");
        connection
            .execute("DELETE FROM notes_nodes", [])
            .expect("remove onboarding fixture nodes");
        connection
    }

    fn insert_history_attachment(connection: &Connection, index: i64, node_id: &str) -> String {
        let id = format!("{index:08x}-dddd-4ddd-8ddd-{index:012x}");
        let content_hash = format!("{index:064x}");
        connection
            .execute(
                "INSERT INTO notes_attachments (\
                   id, node_id, sort_key, relative_path, content_hash, original_name, mime_type, \
                   byte_size, intrinsic_width, intrinsic_height, display_width, created_at, updated_at\
                 ) VALUES (\
                   ?1, ?2, ?3, ?4, ?5, 'history.png', 'image/png', 1, 1, 1, 1, \
                   '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z'\
                 )",
                params![
                    id,
                    node_id,
                    (index + 1) * 1024,
                    format!("notes-assets/{content_hash}.png"),
                    content_hash
                ],
            )
            .expect("insert history attachment");
        id
    }

    fn insert_history_image_node(connection: &Connection, node_id: &str, sort_key: i64) {
        connection
            .execute(
                "INSERT INTO notes_nodes (\
                   id, sort_key, title, note, node_kind, created_at, updated_at\
                 ) VALUES (?1, ?2, 'history.png', '', 'image', \
                   '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')",
                params![node_id, sort_key],
            )
            .expect("insert history image node");
    }

    fn history_new_attachment(index: i64, node_id: &str) -> NewAttachment {
        let content_hash = format!("{index:064x}");
        NewAttachment {
            id: format!("{index:08x}-eeee-4eee-8eee-{index:012x}"),
            node_id: node_id.to_string(),
            relative_path: format!("notes-assets/{content_hash}.png"),
            content_hash,
            original_name: "history.png".to_string(),
            mime_type: "image/png".to_string(),
            byte_size: 1,
            intrinsic_width: 1,
            intrinsic_height: 1,
            display_width: 1,
        }
    }

    #[test]
    fn attachment_history_batch_failure_rolls_back_metadata_and_history_entry() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        create_node(&mut connection, create_input(NODE_ID, None, None, "Root")).expect("root");
        let context = history_context(1, "importAttachments");

        let error = journal(&mut connection, &context, |connection| {
            create_attachments_coordinated_for_node(
                connection,
                NODE_ID,
                vec![
                    history_new_attachment(30_000, NODE_ID),
                    history_new_attachment(30_001, NODE_ID),
                ],
                || Ok(()),
                || Err("identity changed".to_string()),
            )
        })
        .expect_err("coordinated failure");

        assert_eq!(error, "identity changed");
        let attachment_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("attachment count");
        assert_eq!(attachment_count, 0);
        assert_eq!(entry_count(&connection), 0);
    }

    #[test]
    fn notes_history_undo_rejects_cross_session_attachment_node_overflow_atomically() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        create_node(&mut connection, create_input(NODE_ID, None, None, "Root")).expect("root");
        let mut removed_id = String::new();
        for index in 0..MAX_NOTE_ATTACHMENTS_PER_NODE {
            let id = insert_history_attachment(&connection, index, NODE_ID);
            if index == 0 {
                removed_id = id;
            }
        }
        let removal = history_context_for_session(SESSION_ID, 1, "removeAttachment");
        journal(&mut connection, &removal, |connection| {
            remove_attachment(connection, &removed_id)
        })
        .expect("session A removal");
        let replacement = history_context_for_session(SECOND_SESSION_ID, 2, "importAttachment");
        journal(&mut connection, &replacement, |connection| {
            create_attachment(connection, history_new_attachment(10_000, NODE_ID))
        })
        .expect("session B replacement");
        let before = active(&connection);

        let error = undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect_err("node capacity conflict");

        assert_eq!(error, "A Note node can contain at most 128 attachments.");
        assert_eq!(active(&connection), before);
        let status = history_status(&connection, SESSION_ID).expect("session A status");
        assert!(status.can_undo);
        assert!(!status.can_redo);
        let is_undone: bool = connection
            .query_row(
                "SELECT is_undone FROM notes_history_entries WHERE id = ?1",
                [&removal.entry_id],
                |row| row.get(0),
            )
            .expect("removal cursor");
        assert!(!is_undone);
    }

    #[test]
    fn notes_history_redo_rejects_an_image_node_with_multiple_attachments_atomically() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        let creation = history_context(1, "importImageNode");
        let attachment = history_new_attachment(40_000, NODE_ID);
        let original_attachment_id = attachment.id.clone();
        let title = attachment.original_name.clone();
        journal(&mut connection, &creation, |connection| {
            create_image_nodes_coordinated(
                connection,
                None,
                None,
                vec![NewImageNode {
                    id: NODE_ID.to_string(),
                    title,
                    attachment,
                }],
                || Ok(()),
                || Ok(()),
            )
        })
        .expect("record valid image creation");

        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect("undo image creation");
        let original_json: String = connection
            .query_row(
                "SELECT after_json FROM notes_history_changes \
                 WHERE entry_id = ?1 AND table_name = 'notes_attachments' AND row_id = ?2",
                params![creation.entry_id, original_attachment_id],
                |row| row.get(0),
            )
            .expect("read original attachment history");
        let replacement = history_new_attachment(40_001, NODE_ID);
        let mut second_snapshot: serde_json::Value =
            serde_json::from_str(&original_json).expect("decode attachment history");
        second_snapshot["id"] = serde_json::json!(replacement.id);
        second_snapshot["sort_key"] = serde_json::json!(2048);
        second_snapshot["relative_path"] = serde_json::json!(replacement.relative_path);
        second_snapshot["content_hash"] = serde_json::json!(replacement.content_hash);
        connection
            .execute(
                "INSERT INTO notes_history_changes(\
                   entry_id, table_name, row_id, ordinal, before_json, after_json\
                 ) VALUES (?1, 'notes_attachments', ?2, 99, NULL, ?3)",
                params![
                    creation.entry_id,
                    replacement.id,
                    serde_json::to_string(&second_snapshot).expect("encode attachment history")
                ],
            )
            .expect("tamper image attachment history");
        let before = active(&connection);

        let error = redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect_err("redo must reject invalid image ownership");

        assert!(error.contains("exactly one attachment"), "{error}");
        assert_eq!(active(&connection), before);
        let attachment_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_attachments WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("image attachment count");
        assert_eq!(attachment_count, 0);
        let is_undone: bool = connection
            .query_row(
                "SELECT is_undone FROM notes_history_entries WHERE id = ?1",
                [&creation.entry_id],
                |row| row.get(0),
            )
            .expect("history cursor");
        assert!(is_undone);
    }

    #[test]
    fn notes_history_redo_rejects_an_image_node_without_an_attachment_atomically() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        let creation = history_context(1, "importImageNode");
        let attachment = history_new_attachment(41_000, NODE_ID);
        let title = attachment.original_name.clone();
        journal(&mut connection, &creation, |connection| {
            create_image_nodes_coordinated(
                connection,
                None,
                None,
                vec![NewImageNode {
                    id: NODE_ID.to_string(),
                    title,
                    attachment,
                }],
                || Ok(()),
                || Ok(()),
            )
        })
        .expect("record valid image creation");
        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect("undo image creation");
        connection
            .execute(
                "UPDATE notes_history_changes SET after_json = NULL \
                 WHERE entry_id = ?1 AND table_name = 'notes_attachments'",
                [&creation.entry_id],
            )
            .expect("tamper attachment creation history");
        let before = active(&connection);

        let error = redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect_err("redo must reject an attachment-free image node");

        assert!(error.contains("exactly one attachment"), "{error}");
        assert_eq!(active(&connection), before);
        let is_undone: bool = connection
            .query_row(
                "SELECT is_undone FROM notes_history_entries WHERE id = ?1",
                [&creation.entry_id],
                |row| row.get(0),
            )
            .expect("history cursor");
        assert!(is_undone);
    }

    #[test]
    fn notes_history_undo_rejects_an_attachment_whose_owner_is_missing_atomically() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        let creation = history_context(1, "importImageNode");
        let attachment = history_new_attachment(41_001, NODE_ID);
        let attachment_id = attachment.id.clone();
        let title = attachment.original_name.clone();
        journal(&mut connection, &creation, |connection| {
            create_image_nodes_coordinated(
                connection,
                None,
                None,
                vec![NewImageNode {
                    id: NODE_ID.to_string(),
                    title,
                    attachment,
                }],
                || Ok(()),
                || Ok(()),
            )
        })
        .expect("record valid image creation");
        connection
            .execute(
                "DELETE FROM notes_history_changes \
                 WHERE entry_id = ?1 AND table_name = 'notes_attachments'",
                [&creation.entry_id],
            )
            .expect("remove attachment creation history");
        let before = active(&connection);

        let error = undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect_err("undo must reject an attachment with no resulting owner");

        assert!(error.contains("owner"), "{error}");
        assert_eq!(active(&connection), before);
        let attachment_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_attachments WHERE id = ?1 AND node_id = ?2",
                params![attachment_id, NODE_ID],
                |row| row.get(0),
            )
            .expect("image attachment count");
        assert_eq!(attachment_count, 1);
        let is_undone: bool = connection
            .query_row(
                "SELECT is_undone FROM notes_history_entries WHERE id = ?1",
                [&creation.entry_id],
                |row| row.get(0),
            )
            .expect("history cursor");
        assert!(!is_undone);
    }

    #[test]
    fn notes_history_undo_rejects_removing_an_image_nodes_only_attachment_atomically() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        let mut attachment = history_new_attachment(42_000, NODE_ID);
        attachment.intrinsic_width = 200;
        attachment.display_width = 160;
        let attachment_id = attachment.id.clone();
        create_image_nodes_coordinated(
            &mut connection,
            None,
            None,
            vec![NewImageNode {
                id: NODE_ID.to_string(),
                title: attachment.original_name.clone(),
                attachment,
            }],
            || Ok(()),
            || Ok(()),
        )
        .expect("create valid image node");
        let creation = history_context(1, "resizeImage");
        journal(&mut connection, &creation, |connection| {
            resize_attachment(connection, &attachment_id, 180)
        })
        .expect("record image attachment update");
        connection
            .execute(
                "UPDATE notes_history_changes SET before_json = NULL \
                 WHERE entry_id = ?1 AND table_name = 'notes_attachments' AND row_id = ?2",
                params![creation.entry_id, attachment_id],
            )
            .expect("tamper attachment undo history");
        let before = active(&connection);

        let error = undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect_err("undo must preserve the image attachment");

        assert!(error.contains("exactly one attachment"), "{error}");
        assert_eq!(active(&connection), before);
        let attachment_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_attachments WHERE id = ?1 AND node_id = ?2",
                params![attachment_id, NODE_ID],
                |row| row.get(0),
            )
            .expect("image attachment count");
        assert_eq!(attachment_count, 1);
        let is_undone: bool = connection
            .query_row(
                "SELECT is_undone FROM notes_history_entries WHERE id = ?1",
                [&creation.entry_id],
                |row| row.get(0),
            )
            .expect("history cursor");
        assert!(!is_undone);
    }

    #[test]
    fn notes_history_redo_validates_both_owners_when_an_attachment_moves() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        let mut first_attachment = history_new_attachment(43_000, NODE_ID);
        first_attachment.intrinsic_width = 200;
        first_attachment.display_width = 160;
        let first_attachment_id = first_attachment.id.clone();
        let second_attachment = history_new_attachment(43_001, CHILD_ID);
        create_image_nodes_coordinated(
            &mut connection,
            None,
            None,
            vec![
                NewImageNode {
                    id: NODE_ID.to_string(),
                    title: first_attachment.original_name.clone(),
                    attachment: first_attachment,
                },
                NewImageNode {
                    id: CHILD_ID.to_string(),
                    title: second_attachment.original_name.clone(),
                    attachment: second_attachment,
                },
            ],
            || Ok(()),
            || Ok(()),
        )
        .expect("create valid image nodes");
        let change = history_context(1, "updateImageAttachment");
        journal(&mut connection, &change, |connection| {
            resize_attachment(connection, &first_attachment_id, 180)
        })
        .expect("record attachment update");
        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect("undo valid attachment update");
        let after_json: String = connection
            .query_row(
                "SELECT after_json FROM notes_history_changes \
                 WHERE entry_id = ?1 AND table_name = 'notes_attachments' AND row_id = ?2",
                params![change.entry_id, first_attachment_id],
                |row| row.get(0),
            )
            .expect("attachment history snapshot");
        let mut moved: serde_json::Value =
            serde_json::from_str(&after_json).expect("decode attachment snapshot");
        moved["node_id"] = serde_json::json!(CHILD_ID);
        connection
            .execute(
                "UPDATE notes_history_changes SET after_json = ?1 \
                 WHERE entry_id = ?2 AND table_name = 'notes_attachments' AND row_id = ?3",
                params![
                    serde_json::to_string(&moved).expect("encode moved attachment"),
                    change.entry_id,
                    first_attachment_id
                ],
            )
            .expect("tamper attachment owner history");
        let before = active(&connection);

        let error = redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect_err("redo must reject invalid source and target image owners");

        assert!(error.contains("exactly one attachment"), "{error}");
        assert_eq!(active(&connection), before);
        for (node_id, expected) in [(NODE_ID, 1_i64), (CHILD_ID, 1_i64)] {
            let count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_attachments WHERE node_id = ?1",
                    [node_id],
                    |row| row.get(0),
                )
                .expect("attachment owner count");
            assert_eq!(count, expected, "owner {node_id}");
        }
    }

    #[test]
    fn notes_history_ignores_an_unrelated_malformed_image_node() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        insert_history_image_node(&connection, THIRD_ID, 2048);
        create_node(
            &mut connection,
            create_input(NODE_ID, None, None, "Text owner"),
        )
        .expect("text owner");
        let mut attachment = history_new_attachment(44_000, NODE_ID);
        attachment.intrinsic_width = 200;
        attachment.display_width = 160;
        let attachment_id = attachment.id.clone();
        create_attachment(&mut connection, attachment).expect("text attachment");
        let change = history_context(1, "updateTextAttachment");
        journal(&mut connection, &change, |connection| {
            resize_attachment(connection, &attachment_id, 180)
        })
        .expect("record text attachment update");

        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect("unrelated malformed image must not block undo");
        redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect("unrelated malformed image must not block redo");
    }

    #[test]
    fn notes_history_undo_rejects_a_live_node_using_the_restored_attachment_id() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        create_node(&mut connection, create_input(NODE_ID, None, None, "Root")).expect("root");
        let attachment_id = insert_history_attachment(&connection, 99, NODE_ID);
        let removal = history_context(1, "removeAttachment");
        journal(&mut connection, &removal, |connection| {
            remove_attachment(connection, &attachment_id)
        })
        .expect("remove attachment");
        connection
            .execute(
                "INSERT INTO notes_nodes (\
                   id, sort_key, title, note, node_kind, created_at, updated_at\
                 ) VALUES (?1, 2048, 'legacy collision', '', 'text', \
                   '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')",
                [&attachment_id],
            )
            .expect("seed legacy live-node collision");
        let before = active(&connection);

        let error = undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect_err("history replay must preserve the shared ID namespace");

        assert!(error.contains("ID namespace"), "{error}");
        assert_eq!(active(&connection), before);
        let attachment_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_attachments WHERE id = ?1",
                [&attachment_id],
                |row| row.get(0),
            )
            .expect("count restored attachment collision");
        assert_eq!(attachment_count, 0);
        let is_undone: bool = connection
            .query_row(
                "SELECT is_undone FROM notes_history_entries WHERE id = ?1",
                [&removal.entry_id],
                |row| row.get(0),
            )
            .expect("removal cursor");
        assert!(!is_undone);
    }

    #[test]
    fn notes_history_redo_rejects_a_live_attachment_using_the_restored_node_id() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        create_node(&mut connection, create_input(NODE_ID, None, None, "Root")).expect("root");
        let creation = history_context(1, "createNode");
        journal(&mut connection, &creation, |connection| {
            create_node(
                connection,
                create_input(CHILD_ID, Some(NODE_ID), None, "History node"),
            )
        })
        .expect("create history node");
        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("undo node creation");
        let content_hash = "f".repeat(64);
        connection
            .execute(
                "INSERT INTO notes_attachments (\
                   id, node_id, sort_key, relative_path, content_hash, original_name, mime_type, \
                   byte_size, intrinsic_width, intrinsic_height, display_width, created_at, updated_at\
                 ) VALUES (?1, ?2, 1024, ?3, ?4, 'legacy.png', 'image/png', 1, 1, 1, 1, \
                   '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')",
                params![
                    CHILD_ID,
                    NODE_ID,
                    format!("notes-assets/{content_hash}.png"),
                    content_hash
                ],
            )
            .expect("seed legacy live-attachment collision");
        let before = active(&connection);

        let error = redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect_err("redo must preserve the shared ID namespace");

        assert!(error.contains("ID namespace"), "{error}");
        assert_eq!(active(&connection), before);
        let node_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_nodes WHERE id = ?1",
                [CHILD_ID],
                |row| row.get(0),
            )
            .expect("count restored node collision");
        assert_eq!(node_count, 0);
        let is_undone: bool = connection
            .query_row(
                "SELECT is_undone FROM notes_history_entries WHERE id = ?1",
                [&creation.entry_id],
                |row| row.get(0),
            )
            .expect("creation cursor");
        assert!(is_undone);
    }

    #[test]
    fn undoing_creation_records_purge_evidence_and_dirties_former_topic_and_trash() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        create_node(&mut connection, create_input(NODE_ID, None, None, "Root")).expect("root");
        let creation = history_context(1, "createNode");
        journal(&mut connection, &creation, |connection| {
            create_node(
                connection,
                create_input(CHILD_ID, Some(NODE_ID), None, "Created child"),
            )
        })
        .expect("create history child");
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();

        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("undo node creation");

        assert!(connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sync_purged_tombstones \
                 WHERE node_id = ?1 AND purged_hlc <> '')",
                [CHILD_ID],
                |row| row.get::<_, bool>(0),
            )
            .unwrap());
        let dirty = connection
            .prepare("SELECT node_id FROM sync_dirty_nodes ORDER BY node_id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(dirty.contains(&NODE_ID.to_string()));
        assert!(dirty.contains(&"__yonalist_trash__".to_string()));
    }

    #[test]
    fn replayed_cross_topic_move_dirties_both_former_and_destination_topics() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        create_node(&mut connection, create_input(NODE_ID, None, None, "First")).unwrap();
        create_node(
            &mut connection,
            create_input(CHILD_ID, Some(NODE_ID), None, "Moved"),
        )
        .unwrap();
        create_node(
            &mut connection,
            create_input(THIRD_ID, None, None, "Second"),
        )
        .unwrap();
        let movement = history_context(1, "moveNode");
        journal(&mut connection, &movement, |connection| {
            move_node(
                connection,
                MoveNodeInput {
                    id: CHILD_ID.to_string(),
                    parent_id: Some(THIRD_ID.to_string()),
                    after_id: None,
                    before_id: None,
                },
            )
        })
        .expect("move between topics");
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();

        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect("undo cross-topic move");

        let dirty = connection
            .prepare("SELECT node_id FROM sync_dirty_nodes ORDER BY node_id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(dirty.contains(&CHILD_ID.to_string()));
        assert!(dirty.contains(&THIRD_ID.to_string()));
    }

    #[test]
    fn notes_history_redo_rejects_attachment_vault_overflow_atomically() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        let node_ids = [
            NODE_ID,
            CHILD_ID,
            THIRD_ID,
            "44444444-4444-4444-8444-444444444444",
            "55555555-5555-4555-8555-555555555555",
        ];
        for (index, node_id) in node_ids.iter().enumerate() {
            create_node(
                &mut connection,
                create_input(
                    node_id,
                    None,
                    (index > 0).then(|| node_ids[index - 1]),
                    node_id,
                ),
            )
            .expect("capacity node");
        }
        for index in 0..(MAX_NOTE_ATTACHMENTS_PER_VAULT - 1) {
            let node_index = usize::try_from(index / MAX_NOTE_ATTACHMENTS_PER_NODE)
                .expect("attachment node index");
            insert_history_attachment(&connection, index, node_ids[node_index]);
        }
        let original = history_context_for_session(SESSION_ID, 3, "importAttachment");
        journal(&mut connection, &original, |connection| {
            create_attachment(connection, history_new_attachment(20_000, node_ids[4]))
        })
        .expect("session A import");
        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("undo import");
        create_attachment(&mut connection, history_new_attachment(20_001, node_ids[4]))
            .expect("unjournaled replacement");
        let before = active(&connection);

        let error = redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect_err("vault capacity conflict");

        assert_eq!(error, "A Notes vault can contain at most 512 attachments.");
        assert_eq!(active(&connection), before);
        let status = history_status(&connection, SESSION_ID).expect("redo status");
        assert!(!status.can_undo);
        assert!(status.can_redo);
        let is_undone: bool = connection
            .query_row(
                "SELECT is_undone FROM notes_history_entries WHERE id = ?1",
                [&original.entry_id],
                |row| row.get(0),
            )
            .expect("import cursor");
        assert!(is_undone);
    }

    #[test]
    fn notes_history_create_undo_redo_and_forward_mutation_ordering_are_authoritative() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        let create_context = history_context(1, "create");

        journal(&mut connection, &create_context, |connection| {
            create_node(connection, create_input(NODE_ID, None, None, "Created"))
        })
        .expect("journaled create");
        assert_eq!(active(&connection).nodes.len(), 1);
        assert_eq!(
            history_status(&connection, SESSION_ID)
                .expect("status")
                .can_undo,
            true
        );

        let undone = undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("undo");
        assert_eq!(
            undone.replayed_entry_id.as_deref(),
            Some(create_context.entry_id.as_str())
        );
        assert!(undone.workspace.nodes.is_empty());
        assert!(!undone.can_undo);
        assert!(undone.can_redo);

        let redone = redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("redo");
        assert_eq!(
            redone.replayed_entry_id.as_deref(),
            Some(create_context.entry_id.as_str())
        );
        assert_eq!(redone.workspace.nodes[0].title, "Created");
        assert!(redone.can_undo);
        assert!(!redone.can_redo);

        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("undo again");
        let replacement = history_context(2, "create");
        journal(&mut connection, &replacement, |connection| {
            create_node(
                connection,
                create_input(CHILD_ID, None, None, "Replacement"),
            )
        })
        .expect("new forward mutation");
        let status = history_status(&connection, SESSION_ID).expect("status after replacement");
        assert!(status.can_undo);
        assert!(!status.can_redo, "a forward mutation must invalidate redo");
    }

    #[test]
    fn notes_history_undo_and_redo_advance_hlc_and_keep_the_node_dirty() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        create_node(&mut connection, create_input(NODE_ID, None, None, "Before"))
            .expect("create node");
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .expect("clear creation dirty marker");
        let before: String = connection
            .query_row(
                "SELECT hlc FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("read initial HLC");

        journal(
            &mut connection,
            &history_context(1, "update"),
            |connection| {
                update_node(
                    connection,
                    UpdateNodeInput {
                        id: NODE_ID.to_string(),
                        title: "After".to_string(),
                        note: String::new(),
                        image_offset_utf16: 0,
                    },
                )
            },
        )
        .expect("journal update");
        let forward: String = connection
            .query_row(
                "SELECT hlc FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("read forward HLC");
        assert!(forward > before);

        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .expect("clear forward dirty marker");
        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("undo update");
        let undone: String = connection
            .query_row(
                "SELECT hlc FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("read undo HLC");
        assert!(undone > forward);
        assert!(connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sync_dirty_nodes WHERE node_id = ?1)",
                [NODE_ID],
                |row| row.get::<_, bool>(0),
            )
            .expect("undo dirty marker"));

        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .expect("clear undo dirty marker");
        redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("redo update");
        let redone: String = connection
            .query_row(
                "SELECT hlc FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("read redo HLC");
        assert!(redone > undone);
        assert!(connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sync_dirty_nodes WHERE node_id = ?1)",
                [NODE_ID],
                |row| row.get::<_, bool>(0),
            )
            .expect("redo dirty marker"));
    }

    #[test]
    fn notes_history_coalesces_text_updates_with_the_same_entry_id() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        create_node(&mut connection, create_input(NODE_ID, None, None, "Before")).expect("seed");
        let context = history_context(1, "updateText");

        for title in ["Middle", "After"] {
            journal(&mut connection, &context, |connection| {
                update_node(
                    connection,
                    UpdateNodeInput {
                        id: NODE_ID.to_string(),
                        title: title.to_string(),
                        note: String::new(),
                        image_offset_utf16: 0,
                    },
                )
            })
            .expect("coalesced update");
        }

        assert_eq!(entry_count(&connection), 1);
        let change_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_history_changes WHERE entry_id = ?1",
                [&context.entry_id],
                |row| row.get(0),
            )
            .expect("change count");
        assert_eq!(change_count, 1);
        assert_eq!(
            undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
                .expect("undo")
                .workspace
                .nodes[0]
                .title,
            "Before"
        );
        assert_eq!(
            redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
                .expect("redo")
                .workspace
                .nodes[0]
                .title,
            "After"
        );
    }

    #[test]
    fn notes_history_replays_image_offset() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        insert_history_image_node(&connection, NODE_ID, 1024);
        insert_history_attachment(&connection, 1, NODE_ID);
        let context = history_context(1, "updateImageOffset");

        journal(&mut connection, &context, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: "A😀B".to_string(),
                    note: String::new(),
                    image_offset_utf16: 3,
                },
            )
        })
        .expect("record image offset");
        let audit_json: String = connection
            .query_row(
                "SELECT after_json FROM notes_history_changes WHERE entry_id = ?1 AND table_name = 'notes_nodes'",
                [&context.entry_id],
                |row| row.get(0),
            )
            .expect("read image audit");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&audit_json).expect("audit JSON")
                ["image_offset_utf16"],
            3
        );

        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("undo image offset");
        redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("redo image offset");
        let restored: i64 = connection
            .query_row(
                "SELECT image_offset_utf16 FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("read replayed offset");
        assert_eq!(restored, 3);
    }

    #[test]
    fn unacknowledged_image_operation_pins_history() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        create_node(&mut connection, create_input(NODE_ID, None, None, "before"))
            .expect("seed node");
        let pinned = history_context(1, "imageAtomEdit");
        journal(&mut connection, &pinned, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: "pinned".to_string(),
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect("record pinned history entry");
        connection
            .execute(
                "INSERT INTO notes_image_atom_operations(\
                   operation_id, session_id, history_epoch, fingerprint, postcondition_digest, result_json\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    pinned.entry_id,
                    pinned.session_id,
                    history_epoch(&connection).expect("epoch"),
                    "a".repeat(64),
                    "b".repeat(64),
                    r#"{"operationId":"00000000-0000-4000-8000-000000000001","historyEpoch":"epoch","postconditionDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","affectedRootIds":["11111111-1111-4111-8111-111111111111"],"focus":{"nodeId":"11111111-1111-4111-8111-111111111111","anchorUtf16":0,"focusUtf16":0}}"#,
                ],
            )
            .expect("record unresolved receipt");

        for index in 2..=usize::try_from(HISTORY_MAX_ENTRIES + 1).expect("entry count") {
            let context = history_context(index, "updateText");
            journal(&mut connection, &context, |connection| {
                update_node(
                    connection,
                    UpdateNodeInput {
                        id: NODE_ID.to_string(),
                        title: format!("update-{index}"),
                        note: String::new(),
                        image_offset_utf16: 0,
                    },
                )
            })
            .expect("record capacity mutation");
        }

        let pinned_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notes_history_entries WHERE id = ?1)",
                [&pinned.entry_id],
                |row| row.get(0),
            )
            .expect("inspect pinned entry");
        assert!(
            pinned_exists,
            "an unresolved receipt pins its history entry"
        );

        connection
            .execute(
                "UPDATE notes_image_atom_operations SET acknowledged = 1 WHERE operation_id = ?1",
                [&pinned.entry_id],
            )
            .expect("acknowledge receipt");
        let after_ack = history_context(
            usize::try_from(HISTORY_MAX_ENTRIES + 2).expect("next"),
            "updateText",
        );
        journal(&mut connection, &after_ack, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: "after acknowledgement".to_string(),
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect("prune acknowledged entry");
        let receipt_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notes_image_atom_operations WHERE operation_id = ?1)",
                [&pinned.entry_id],
                |row| row.get(0),
            )
            .expect("inspect pruned receipt");
        assert!(!receipt_exists, "acknowledged receipts prune with history");
    }

    #[test]
    fn manual_prune_rejects_an_unacknowledged_image_operation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        create_node(&mut connection, create_input(NODE_ID, None, None, "before"))
            .expect("seed node");
        let epoch = history_epoch(&connection).expect("epoch");
        let context = history_context(1, "imageAtomEdit");
        journal(&mut connection, &context, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: "pinned".to_string(),
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect("record history entry");
        crate::notes::image_atom::record_operation_receipt(
            &connection,
            SESSION_ID,
            "a".repeat(64),
            &ImageAtomOperationReceiptResult {
                operation_id: context.entry_id.clone(),
                history_epoch: epoch.clone(),
                postcondition_digest: "b".repeat(64),
                affected_root_ids: vec![NODE_ID.to_string()],
                focus: ImageAtomFocusResult {
                    node_id: NODE_ID.to_string(),
                    anchor_utf16: 0,
                    focus_utf16: 0,
                },
            },
        )
        .expect("record receipt");

        assert!(prune_history_entries(
            &mut connection,
            &NotesPruneHistoryInput {
                session_id: SESSION_ID.to_string(),
                history_epoch: epoch,
                entry_ids: vec![context.entry_id.clone()],
            },
        )
        .expect_err("unacknowledged receipts cannot be manually pruned")
        .contains("unacknowledged"));
        let entry_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notes_history_entries WHERE id = ?1)",
                [&context.entry_id],
                |row| row.get(0),
            )
            .expect("inspect pinned history entry");
        assert!(entry_exists);
    }

    #[test]
    fn protected_current_entry_rolls_back_when_all_history_is_pinned() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        create_node(&mut connection, create_input(NODE_ID, None, None, "before"))
            .expect("seed node");
        let epoch = history_epoch(&connection).expect("epoch");

        for index in 1..=usize::try_from(HISTORY_MAX_ENTRIES).expect("entry count") {
            let context = history_context(index, "imageAtomEdit");
            journal(&mut connection, &context, |connection| {
                update_node(
                    connection,
                    UpdateNodeInput {
                        id: NODE_ID.to_string(),
                        title: format!("pinned-{index}"),
                        note: String::new(),
                        image_offset_utf16: 0,
                    },
                )
            })
            .expect("record pinned history entry");
            connection
                .execute(
                    "INSERT INTO notes_image_atom_operations(\
                       operation_id, session_id, history_epoch, fingerprint, postcondition_digest, result_json\
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        context.entry_id,
                        context.session_id,
                        epoch,
                        format!("{index:064x}"),
                        "b".repeat(64),
                        r#"{"operationId":"00000000-0000-4000-8000-000000000001","historyEpoch":"epoch","postconditionDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","affectedRootIds":["11111111-1111-4111-8111-111111111111"],"focus":{"nodeId":"11111111-1111-4111-8111-111111111111","anchorUtf16":0,"focusUtf16":0}}"#,
                    ],
                )
                .expect("pin history entry");
        }
        let before = active(&connection);
        let proposed = history_context(
            usize::try_from(HISTORY_MAX_ENTRIES + 1).expect("proposed index"),
            "imageAtomEdit",
        );

        let error = journal(&mut connection, &proposed, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: "must roll back".to_string(),
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect_err("cannot evict an unresolved receipt or current operation");

        assert!(error.contains("limits"), "{error}");
        assert_eq!(
            active(&connection),
            before,
            "live rows roll back atomically"
        );
        assert_eq!(entry_count(&connection), HISTORY_MAX_ENTRIES);
        let proposed_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notes_history_entries WHERE id = ?1)",
                [&proposed.entry_id],
                |row| row.get(0),
            )
            .expect("inspect proposed entry");
        assert!(
            !proposed_exists,
            "current protected entry rolls back with the mutation"
        );
    }

    #[test]
    fn hard_limit_rollback_removes_a_proposed_receipt_row() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        create_node(&mut connection, create_input(NODE_ID, None, None, "before"))
            .expect("seed node");
        let epoch = history_epoch(&connection).expect("epoch");

        // Direct setup intentionally bypasses record_operation_receipt: its public
        // authority permits only one unresolved receipt, while this test needs every
        // evictable entry pinned to prove transaction rollback of the proposed row.
        for index in 1..=usize::try_from(HISTORY_MAX_ENTRIES).expect("entry count") {
            let context = history_context(index, "imageAtomEdit");
            connection
                .execute(
                    "INSERT INTO notes_history_entries(id, session_id, sequence, command_kind) \
                     VALUES (?1, ?2, ?3, ?4)",
                    params![
                        &context.entry_id,
                        &context.session_id,
                        i64::try_from(index).expect("sequence"),
                        &context.command_kind,
                    ],
                )
                .expect("seed pinned history entry");
            connection
                .execute(
                    "INSERT INTO notes_image_atom_operations(\
                       operation_id, session_id, history_epoch, fingerprint, postcondition_digest, result_json\
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        &context.entry_id,
                        &context.session_id,
                        &epoch,
                        format!("{index:064x}"),
                        "b".repeat(64),
                        "{}",
                    ],
                )
                .expect("seed unresolved receipt");
        }
        let proposed = history_context(
            usize::try_from(HISTORY_MAX_ENTRIES + 1).expect("proposed index"),
            "imageAtomEdit",
        );
        let before = active(&connection);
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("begin proposed mutation");
        transaction
            .execute(
                "UPDATE notes_nodes SET title = 'must roll back' WHERE id = ?1",
                [NODE_ID],
            )
            .expect("stage live mutation");
        transaction
            .execute(
                "INSERT INTO notes_history_entries(id, session_id, sequence, command_kind) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    &proposed.entry_id,
                    &proposed.session_id,
                    HISTORY_MAX_ENTRIES + 1,
                    &proposed.command_kind,
                ],
            )
            .expect("stage proposed history entry");
        transaction
            .execute(
                "INSERT INTO notes_image_atom_operations(\
                   operation_id, session_id, history_epoch, fingerprint, postcondition_digest, result_json\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    &proposed.entry_id,
                    &proposed.session_id,
                    &epoch,
                    "c".repeat(64),
                    "b".repeat(64),
                    "{}",
                ],
            )
            .expect("stage proposed receipt");

        assert!(enforce_limits(&transaction, Some(&proposed.entry_id))
            .expect_err("all entries are pinned")
            .contains("limits"));
        transaction.rollback().expect("roll back proposed mutation");

        assert_eq!(active(&connection), before, "live rows roll back");
        let proposed_history_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notes_history_entries WHERE id = ?1)",
                [&proposed.entry_id],
                |row| row.get(0),
            )
            .expect("inspect proposed history entry");
        let proposed_receipt_exists: bool = connection
            .query_row(
                "SELECT EXISTS(\
                   SELECT 1 FROM notes_image_atom_operations WHERE operation_id = ?1\
                 )",
                [&proposed.entry_id],
                |row| row.get(0),
            )
            .expect("inspect proposed receipt");
        assert!(
            !proposed_history_exists,
            "proposed history entry rolls back"
        );
        assert!(!proposed_receipt_exists, "proposed receipt rolls back");
    }

    #[test]
    fn reset_and_close_clear_image_operation_receipts_before_history_teardown() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        create_node(&mut connection, create_input(NODE_ID, None, None, "before"))
            .expect("seed node");
        let epoch = history_epoch(&connection).expect("epoch");
        let record = |connection: &mut Connection, index: usize, title: &str| {
            let context = NotesHistoryContext {
                history_epoch: epoch.clone(),
                ..history_context(index, "imageAtomEdit")
            };
            journal(connection, &context, |connection| {
                update_node(
                    connection,
                    UpdateNodeInput {
                        id: NODE_ID.to_string(),
                        title: title.to_string(),
                        note: String::new(),
                        image_offset_utf16: 0,
                    },
                )
            })
            .expect("record history mutation");
            crate::notes::image_atom::record_operation_receipt(
                connection,
                SESSION_ID,
                format!("{index:064x}"),
                &ImageAtomOperationReceiptResult {
                    operation_id: context.entry_id,
                    history_epoch: epoch.clone(),
                    postcondition_digest: "b".repeat(64),
                    affected_root_ids: vec![NODE_ID.to_string()],
                    focus: ImageAtomFocusResult {
                        node_id: NODE_ID.to_string(),
                        anchor_utf16: 0,
                        focus_utf16: 1,
                    },
                },
            )
            .expect("record receipt");
        };

        record(&mut connection, 1, "for close");
        close_all_history(&mut connection, SESSION_ID, &epoch).expect("close history");
        let after_close: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_image_atom_operations",
                [],
                |row| row.get(0),
            )
            .expect("count closed receipts");
        assert_eq!(after_close, 0);

        record(&mut connection, 2, "for reset");
        let (_, reset) = reset_history(
            &mut connection,
            &crate::notes::types::NotesHistoryResetInput {
                session_id: SESSION_ID.to_string(),
                history_epoch: epoch.clone(),
            },
        )
        .expect("reset history");
        let after_reset: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_image_atom_operations",
                [],
                |row| row.get(0),
            )
            .expect("count reset receipts");
        assert_eq!(after_reset, 0);
        assert_ne!(reset.state.history_epoch, epoch);
    }

    #[test]
    fn notes_history_replays_split_and_move_with_sibling_rebalance() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        create_node(
            &mut connection,
            create_input(NODE_ID, None, None, "AlphaBeta"),
        )
        .expect("root");
        create_node(
            &mut connection,
            create_input(CHILD_ID, None, Some(NODE_ID), "Second"),
        )
        .expect("second");
        create_node(
            &mut connection,
            create_input(THIRD_ID, None, Some(CHILD_ID), "Third"),
        )
        .expect("third");

        let split_context = history_context(1, "split");
        journal(&mut connection, &split_context, |connection| {
            split_node(
                connection,
                SplitNodeInput {
                    id: NODE_ID.to_string(),
                    new_node_id: "44444444-4444-4444-8444-444444444444".to_string(),
                    prefix: "Alpha".to_string(),
                    suffix: "Beta".to_string(),
                },
            )
        })
        .expect("split");
        let after_split = active(&connection);
        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("undo split");
        assert_eq!(
            active(&connection)
                .nodes
                .iter()
                .map(|node| node.title.as_str())
                .collect::<Vec<_>>(),
            vec!["AlphaBeta", "Second", "Third"]
        );
        assert_eq!(
            redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
                .expect("redo split")
                .workspace,
            after_split
        );

        connection.execute("UPDATE notes_nodes SET sort_key = CASE id WHEN ?1 THEN 1 WHEN ?2 THEN 2 ELSE 3 END", params![NODE_ID, CHILD_ID]).expect("force exhausted gaps");
        let before_move = active(&connection);
        let move_context = history_context(2, "move");
        journal(&mut connection, &move_context, |connection| {
            move_node(
                connection,
                MoveNodeInput {
                    id: THIRD_ID.to_string(),
                    parent_id: None,
                    after_id: None,
                    before_id: Some(CHILD_ID.to_string()),
                },
            )
        })
        .expect("rebalance move");
        let after_move = active(&connection);
        let changed_rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_history_changes WHERE entry_id = ?1",
                [&move_context.entry_id],
                |row| row.get(0),
            )
            .expect("rebalanced row snapshots");
        assert!(
            changed_rows >= 4,
            "the move must snapshot rebalanced siblings"
        );
        assert_eq!(after_move.nodes[1].id, THIRD_ID);
        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("undo move");
        assert_eq!(active(&connection), before_move);
        assert_eq!(
            redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
                .expect("redo move")
                .workspace,
            after_move
        );
    }

    #[test]
    fn notes_history_replays_toggles_and_duplicate_in_reverse_then_forward_order() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        create_node(&mut connection, create_input(NODE_ID, None, None, "Root")).expect("root");
        create_node(
            &mut connection,
            create_input(CHILD_ID, Some(NODE_ID), None, "Child"),
        )
        .expect("child");

        for (index, kind) in ["complete", "collapse", "star"].into_iter().enumerate() {
            let context = history_context(index + 1, kind);
            journal(&mut connection, &context, |connection| match kind {
                "complete" => toggle_complete(connection, NODE_ID),
                "collapse" => toggle_collapsed(connection, NODE_ID),
                _ => toggle_star(connection, NODE_ID),
            })
            .expect("toggle");
        }
        let duplicate_context = history_context(4, "duplicate");
        journal(&mut connection, &duplicate_context, |connection| {
            duplicate_node(connection, NODE_ID)
        })
        .expect("duplicate");
        assert_eq!(active(&connection).nodes.len(), 4);

        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("undo duplicate");
        assert_eq!(active(&connection).nodes.len(), 2);
        for expected in [
            (true, true, false),
            (true, false, false),
            (false, false, false),
        ] {
            let replay = undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
                .expect("undo toggle");
            let root = replay
                .workspace
                .nodes
                .iter()
                .find(|node| node.id == NODE_ID)
                .expect("root");
            assert_eq!(
                (
                    root.completed_at.is_some(),
                    root.is_collapsed,
                    root.is_starred
                ),
                expected
            );
        }
        for _ in 0..4 {
            redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("redo command");
        }
        assert_eq!(active(&connection).nodes.len(), 4);
    }

    #[test]
    fn notes_history_replays_batch_duplicate_with_identical_forest_and_attachment_ids() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        create_node(
            &mut connection,
            create_input(NODE_ID, None, None, "A #Root"),
        )
        .expect("first root");
        create_node(
            &mut connection,
            create_input(CHILD_ID, Some(NODE_ID), None, "A child #Nested"),
        )
        .expect("child");
        create_node(
            &mut connection,
            create_input(THIRD_ID, None, Some(NODE_ID), "B #Root"),
        )
        .expect("second root");
        insert_history_attachment(&connection, 1, NODE_ID);
        insert_history_attachment(&connection, 2, CHILD_ID);
        insert_history_attachment(&connection, 3, THIRD_ID);
        let context = history_context(1, "batchDuplicate");

        let duplicated = journal(&mut connection, &context, |connection| {
            apply_batch(
                connection,
                ApplyBatchInput {
                    node_ids: vec![
                        THIRD_ID.to_string(),
                        CHILD_ID.to_string(),
                        NODE_ID.to_string(),
                    ],
                    op: BatchOp::Duplicate,
                },
            )
        })
        .expect("batch duplicate");

        let root_ids = connection
            .prepare(
                "SELECT id FROM notes_nodes WHERE parent_id IS NULL AND deleted_at IS NULL \
                 AND archived_at IS NULL ORDER BY sort_key, id",
            )
            .expect("prepare roots")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query roots")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect roots");
        assert_eq!(root_ids.len(), 4);
        let copied_root_ids = [root_ids[2].clone(), root_ids[3].clone()];
        let copied_child_id = duplicated
            .nodes
            .iter()
            .find(|node| node.parent_id.as_deref() == Some(copied_root_ids[0].as_str()))
            .expect("copied child")
            .id
            .clone();
        let copied_node_ids = [
            copied_root_ids[0].clone(),
            copied_child_id.clone(),
            copied_root_ids[1].clone(),
        ]
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
        let mut node_snapshot = duplicated
            .nodes
            .iter()
            .filter(|node| copied_node_ids.contains(&node.id))
            .cloned()
            .collect::<Vec<_>>();
        node_snapshot.sort_by(|left, right| left.id.cmp(&right.id));
        let attachment_snapshot = connection
            .prepare(
                "SELECT id, node_id, sort_key, relative_path, content_hash \
                 FROM notes_attachments \
                 WHERE node_id IN (?1, ?2, ?3) ORDER BY id",
            )
            .expect("prepare copied attachment snapshot")
            .query_map(
                params![&copied_root_ids[0], &copied_child_id, &copied_root_ids[1]],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .expect("query copied attachment snapshot")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect copied attachment snapshot");
        assert_eq!(attachment_snapshot.len(), 3);
        assert_eq!(entry_count(&connection), 1);

        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect("undo batch duplicate");
        assert!(active(&connection)
            .nodes
            .iter()
            .all(|node| !copied_node_ids.contains(&node.id)));
        let attachment_count_after_undo: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("attachment count after undo");
        assert_eq!(attachment_count_after_undo, 3);

        let redone = redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect("redo batch duplicate");
        let mut restored_nodes = redone
            .workspace
            .nodes
            .iter()
            .filter(|node| copied_node_ids.contains(&node.id))
            .cloned()
            .collect::<Vec<_>>();
        restored_nodes.sort_by(|left, right| left.id.cmp(&right.id));
        assert_eq!(restored_nodes, node_snapshot);
        let restored_attachments = connection
            .prepare(
                "SELECT id, node_id, sort_key, relative_path, content_hash \
                 FROM notes_attachments \
                 WHERE node_id IN (?1, ?2, ?3) ORDER BY id",
            )
            .expect("prepare restored attachment snapshot")
            .query_map(
                params![&copied_root_ids[0], &copied_child_id, &copied_root_ids[1]],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .expect("query restored attachment snapshot")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect restored attachment snapshot");
        assert_eq!(restored_attachments, attachment_snapshot);
        assert_eq!(entry_count(&connection), 1);
    }

    #[test]
    fn notes_history_replays_trash_restore_archive_and_unarchive() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        create_node(&mut connection, create_input(NODE_ID, None, None, "Root")).expect("root");
        create_node(
            &mut connection,
            create_input(CHILD_ID, Some(NODE_ID), None, "Child"),
        )
        .expect("child");

        let trash_context = history_context(1, "trash");
        journal(&mut connection, &trash_context, |connection| {
            soft_delete_node(connection, NODE_ID)
        })
        .expect("trash");
        assert!(active(&connection).nodes.is_empty());
        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("undo trash");
        assert_eq!(active(&connection).nodes.len(), 2);
        redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Trash).expect("redo trash");

        let restore_context = history_context(2, "restore");
        journal(&mut connection, &restore_context, |connection| {
            restore_node(connection, NODE_ID)
        })
        .expect("restore");
        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Trash).expect("undo restore");
        redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("redo restore");

        let archive_context = history_context(3, "archive");
        journal(&mut connection, &archive_context, |connection| {
            archive_node(connection, NODE_ID)
        })
        .expect("archive");
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Archive)
                .expect("archive")
                .nodes
                .len(),
            2
        );
        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("undo archive");
        let unarchive_seed = history_context(4, "archive");
        journal(&mut connection, &unarchive_seed, |connection| {
            archive_node(connection, NODE_ID)
        })
        .expect("archive again");
        let unarchive_context = history_context(5, "unarchive");
        journal(&mut connection, &unarchive_context, |connection| {
            unarchive_node(connection, NODE_ID)
        })
        .expect("unarchive");
        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Archive).expect("undo unarchive");
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Archive)
                .expect("archive")
                .nodes
                .len(),
            2
        );
        redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("redo unarchive");
        assert_eq!(active(&connection).nodes.len(), 2);
    }

    #[test]
    fn notes_history_trash_persists_command_kind() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        create_node(&mut connection, create_input(NODE_ID, None, None, "Root")).expect("root");

        let context = history_context(1, "trash");
        let result =
            with_history_transaction_and_prunes(&mut connection, Some(&context), |connection| {
                soft_delete_node(connection, NODE_ID)
            })
            .expect("trash with history command kind");

        assert_eq!(
            result.history_entry_id.as_deref(),
            Some(context.entry_id.as_str())
        );
        assert!(result.workspace.nodes.is_empty());
        let stored: String = connection
            .query_row(
                "SELECT command_kind FROM notes_history_entries WHERE id = ?1",
                [&context.entry_id],
                |row| row.get(0),
            )
            .expect("stored command kind");
        assert_eq!(stored, "trash");
    }

    #[test]
    fn notes_history_rebuilds_search_tags_and_exact_derived_dates_on_replay() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        create_node(
            &mut connection,
            create_input(NODE_ID, None, None, "Before #before 07/11/2026"),
        )
        .expect("seed");
        let context = history_context(1, "updateText");
        journal(&mut connection, &context, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: "After #after 07/12/2026".to_string(),
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect("update");
        connection
            .execute("DELETE FROM notes_dates WHERE node_id = ?1", [NODE_ID])
            .expect("clear derived date before replay");

        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("undo");
        assert_eq!(list_tags(&connection).expect("tags"), vec!["before"]);
        assert_eq!(
            search_nodes(&connection, "Before")
                .expect("before search")
                .len(),
            1
        );
        assert!(search_nodes(&connection, "After")
            .expect("after search")
            .is_empty());
        let before_query = NoteStructuredSearchQuery {
            text: String::new(),
            required_tags: vec![NoteSearchTag {
                prefix: NoteTagPrefix::Hash,
                normalized_tag: "before".to_string(),
                display_tag: "before".to_string(),
            }],
            excluded_tags: vec![],
            or_groups: vec![],
        };
        assert_eq!(
            search_nodes_structured(&connection, &before_query)
                .expect("structured before search")
                .len(),
            1
        );
        let date_row: (String, String, String) = connection
            .query_row(
                "SELECT normalized_start, normalized_end, token_text FROM notes_dates WHERE node_id = ?1",
                [NODE_ID],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("dates");
        assert_eq!(
            date_row,
            (
                "2026-07-11".to_string(),
                "2026-07-11".to_string(),
                "07/11/2026".to_string()
            )
        );

        redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("redo");
        assert_eq!(list_tags(&connection).expect("tags"), vec!["after"]);
        assert_eq!(
            search_nodes(&connection, "After")
                .expect("after search")
                .len(),
            1
        );
        assert!(search_nodes_structured(&connection, &before_query)
            .expect("structured before search after redo")
            .is_empty());
        let redone_date: String = connection
            .query_row(
                "SELECT token_text FROM notes_dates WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("redone date");
        assert_eq!(redone_date, "07/12/2026");
    }

    #[test]
    fn notes_history_replay_keeps_image_filenames_out_of_derived_content() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        let filename = "#urgent 2026-07-14 image.png";
        connection
            .execute(
                "INSERT INTO notes_nodes(\
                   id, sort_key, title, note, node_kind, created_at, updated_at\
                 ) VALUES (?1, 1024, '', '', 'image', \
                   '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')",
                params![NODE_ID],
            )
            .expect("seed image node");
        let attachment_id = insert_history_attachment(&connection, 70_001, NODE_ID);
        connection
            .execute(
                "UPDATE notes_attachments SET original_name = ?1 WHERE id = ?2",
                params![filename, attachment_id],
            )
            .expect("seed image filename");
        update_node(
            &mut connection,
            UpdateNodeInput {
                id: NODE_ID.to_string(),
                title: String::new(),
                note: "Before #before 07/15/2026".to_string(),
                image_offset_utf16: 0,
            },
        )
        .expect("seed image note projections");

        let context = history_context(1, "updateText");
        journal(&mut connection, &context, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: String::new(),
                    note: "After #after 07/16/2026".to_string(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect("journal image note update");

        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("undo image note");
        assert_eq!(list_tags(&connection).expect("undo tags"), vec!["before"]);
        let undone_dates = connection
            .prepare("SELECT token_text FROM notes_dates WHERE node_id = ?1 ORDER BY token_text")
            .expect("prepare undo dates")
            .query_map([NODE_ID], |row| row.get::<_, String>(0))
            .expect("query undo dates")
            .collect::<Result<Vec<_>, _>>()
            .expect("read undo dates");
        assert_eq!(undone_dates, vec!["07/15/2026"]);
        assert_eq!(
            search_nodes(&connection, "urgent")
                .expect("filename full-text search")
                .len(),
            1
        );

        redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("redo image note");
        assert_eq!(list_tags(&connection).expect("redo tags"), vec!["after"]);
        let redone_dates = connection
            .prepare("SELECT token_text FROM notes_dates WHERE node_id = ?1 ORDER BY token_text")
            .expect("prepare redo dates")
            .query_map([NODE_ID], |row| row.get::<_, String>(0))
            .expect("query redo dates")
            .collect::<Result<Vec<_>, _>>()
            .expect("read redo dates");
        assert_eq!(redone_dates, vec!["07/16/2026"]);
    }

    #[test]
    fn notes_history_failed_mutation_and_invalid_contexts_leave_no_journal() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        create_node(&mut connection, create_input(NODE_ID, None, None, "Root")).expect("root");
        create_node(
            &mut connection,
            create_input(CHILD_ID, Some(NODE_ID), None, "Child"),
        )
        .expect("child");
        let before = active(&connection);
        let context = history_context(1, "move");
        let error = journal(&mut connection, &context, |connection| {
            move_node(
                connection,
                MoveNodeInput {
                    id: NODE_ID.to_string(),
                    parent_id: Some(CHILD_ID.to_string()),
                    after_id: None,
                    before_id: None,
                },
            )
        })
        .expect_err("cycle must fail");
        assert!(error.contains("descendant"));
        assert_eq!(active(&connection), before);
        assert_eq!(entry_count(&connection), 0);

        for invalid in [
            NotesHistoryContext {
                session_id: "bad".to_string(),
                ..history_context(2, "update")
            },
            NotesHistoryContext {
                entry_id: "bad".to_string(),
                ..history_context(3, "update")
            },
            NotesHistoryContext {
                command_kind: "  ".to_string(),
                ..history_context(4, "update")
            },
        ] {
            assert!(journal(&mut connection, &invalid, |connection| toggle_star(
                connection, NODE_ID
            ))
            .is_err());
        }
        assert_eq!(entry_count(&connection), 0);
        assert!(history_status(&connection, "bad").is_err());
    }

    #[test]
    fn notes_history_rejects_stale_cross_session_title_undo_without_mutation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        create_node(&mut connection, create_input(NODE_ID, None, None, "Before")).expect("seed");
        let first = history_context(1, "updateText");
        journal(&mut connection, &first, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: "Session A".to_string(),
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect("session A update");
        let second = history_context_for_session(SECOND_SESSION_ID, 2, "updateText");
        journal(&mut connection, &second, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: "Session B".to_string(),
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect("session B update");
        let before_replay = active(&connection);

        let error = undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect_err("stale session A undo must conflict");

        assert!(error.to_lowercase().contains("history conflict"), "{error}");
        assert_eq!(active(&connection), before_replay);
        assert!(
            history_status(&connection, SESSION_ID)
                .expect("session A status")
                .can_undo
        );
    }

    #[test]
    fn notes_history_invalidates_cross_session_redo_after_a_forward_mutation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        create_node(&mut connection, create_input(NODE_ID, None, None, "Before")).expect("seed");
        let first = history_context(1, "updateText");
        journal(&mut connection, &first, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: "Session A".to_string(),
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect("session A update");
        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("session A undo");
        assert!(
            history_status(&connection, SESSION_ID)
                .expect("session A redo status")
                .can_redo
        );

        let second = history_context_for_session(SECOND_SESSION_ID, 2, "updateText");
        journal(&mut connection, &second, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: "Session B".to_string(),
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect("session B update");

        assert!(
            !history_status(&connection, SESSION_ID)
                .expect("session A invalidated status")
                .can_redo
        );
        let replay = redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect("invalidated redo is an empty replay");
        assert_eq!(replay.replayed_entry_id, None);
        assert_eq!(replay.workspace.nodes[0].title, "Session B");
    }

    #[test]
    fn notes_history_coalesced_forward_mutation_invalidates_cross_session_redo() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        create_node(
            &mut connection,
            create_input(NODE_ID, None, None, "Session B before"),
        )
        .expect("session B node");
        create_node(
            &mut connection,
            create_input(CHILD_ID, None, Some(NODE_ID), "Session A before"),
        )
        .expect("session A node");

        let session_b = history_context_for_session(SECOND_SESSION_ID, 1, "updateText");
        journal(&mut connection, &session_b, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: "Session B journaled".to_string(),
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect("session B update");
        let session_a = history_context(2, "updateText");
        journal(&mut connection, &session_a, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: CHILD_ID.to_string(),
                    title: "Session A first burst".to_string(),
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect("session A update");
        undo(
            &mut connection,
            SECOND_SESSION_ID,
            NotesWorkspaceScope::Active,
        )
        .expect("session B undo");
        assert!(
            history_status(&connection, SECOND_SESSION_ID)
                .expect("session B redo status")
                .can_redo
        );

        journal(&mut connection, &session_a, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: CHILD_ID.to_string(),
                    title: "Session A coalesced burst".to_string(),
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect("session A coalesced update");

        assert!(
            !history_status(&connection, SECOND_SESSION_ID)
                .expect("session B invalidated status")
                .can_redo
        );
        let replay = redo(
            &mut connection,
            SECOND_SESSION_ID,
            NotesWorkspaceScope::Active,
        )
        .expect("invalidated session B redo");
        assert_eq!(replay.replayed_entry_id, None);
        assert_eq!(
            replay
                .workspace
                .nodes
                .iter()
                .find(|node| node.id == NODE_ID)
                .expect("session B node")
                .title,
            "Session B before"
        );
    }

    #[test]
    fn notes_history_rejects_stale_redo_expected_state_without_mutation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        create_node(&mut connection, create_input(NODE_ID, None, None, "Before")).expect("seed");
        let context = history_context(1, "updateText");
        journal(&mut connection, &context, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: "Journaled".to_string(),
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect("journaled update");
        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("undo");
        update_node(
            &mut connection,
            UpdateNodeInput {
                id: NODE_ID.to_string(),
                title: "Newer unjournaled state".to_string(),
                note: String::new(),
                image_offset_utf16: 0,
            },
        )
        .expect("newer unjournaled update");
        let before_replay = active(&connection);

        let error = redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect_err("stale redo must conflict");

        assert!(error.to_lowercase().contains("history conflict"), "{error}");
        assert_eq!(active(&connection), before_replay);
        assert!(
            history_status(&connection, SESSION_ID)
                .expect("redo remains available after conflict")
                .can_redo
        );
    }

    #[test]
    fn notes_history_undo_rejects_a_projected_hierarchy_cycle_atomically() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        create_node(&mut connection, create_input(NODE_ID, None, None, "Root")).expect("root");
        create_node(
            &mut connection,
            create_input(CHILD_ID, Some(NODE_ID), None, "Child"),
        )
        .expect("child");
        let change = history_context(1, "updateText");
        journal(&mut connection, &change, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: "Updated root".to_string(),
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect("record root update");
        let before_json: String = connection
            .query_row(
                "SELECT before_json FROM notes_history_changes \
                 WHERE entry_id = ?1 AND table_name = 'notes_nodes' AND row_id = ?2",
                params![change.entry_id, NODE_ID],
                |row| row.get(0),
            )
            .expect("root before snapshot");
        let mut cyclic: serde_json::Value =
            serde_json::from_str(&before_json).expect("decode root before snapshot");
        cyclic["parent_id"] = serde_json::json!(CHILD_ID);
        connection
            .execute(
                "UPDATE notes_history_changes SET before_json = ?1 \
                 WHERE entry_id = ?2 AND table_name = 'notes_nodes' AND row_id = ?3",
                params![
                    serde_json::to_string(&cyclic).expect("encode cyclic root snapshot"),
                    change.entry_id,
                    NODE_ID
                ],
            )
            .expect("tamper root undo snapshot");
        let before = active(&connection);

        let error = undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect_err("undo must reject a projected hierarchy cycle");

        assert!(error.to_lowercase().contains("cycle"), "{error}");
        assert_eq!(active(&connection), before);
        let is_undone: bool = connection
            .query_row(
                "SELECT is_undone FROM notes_history_entries WHERE id = ?1",
                [&change.entry_id],
                |row| row.get(0),
            )
            .expect("history cursor");
        assert!(!is_undone);
    }

    #[test]
    fn notes_history_redo_rejects_a_projected_hierarchy_cycle_atomically() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        create_node(&mut connection, create_input(NODE_ID, None, None, "Root")).expect("root");
        create_node(
            &mut connection,
            create_input(CHILD_ID, Some(NODE_ID), None, "Child"),
        )
        .expect("child");
        let change = history_context(1, "updateText");
        journal(&mut connection, &change, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: "Updated root".to_string(),
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect("record root update");
        undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("valid undo");
        let after_json: String = connection
            .query_row(
                "SELECT after_json FROM notes_history_changes \
                 WHERE entry_id = ?1 AND table_name = 'notes_nodes' AND row_id = ?2",
                params![change.entry_id, NODE_ID],
                |row| row.get(0),
            )
            .expect("root after snapshot");
        let mut cyclic: serde_json::Value =
            serde_json::from_str(&after_json).expect("decode root after snapshot");
        cyclic["parent_id"] = serde_json::json!(CHILD_ID);
        connection
            .execute(
                "UPDATE notes_history_changes SET after_json = ?1 \
                 WHERE entry_id = ?2 AND table_name = 'notes_nodes' AND row_id = ?3",
                params![
                    serde_json::to_string(&cyclic).expect("encode cyclic root snapshot"),
                    change.entry_id,
                    NODE_ID
                ],
            )
            .expect("tamper root redo snapshot");
        let before = active(&connection);

        let error = redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect_err("redo must reject a projected hierarchy cycle");

        assert!(error.to_lowercase().contains("cycle"), "{error}");
        assert_eq!(active(&connection), before);
        let is_undone: bool = connection
            .query_row(
                "SELECT is_undone FROM notes_history_entries WHERE id = ?1",
                [&change.entry_id],
                |row| row.get(0),
            )
            .expect("history cursor");
        assert!(is_undone);
    }

    #[test]
    fn notes_history_redo_cannot_create_a_live_child_under_inactive_parent() {
        for lifecycle in ["archive", "trash"] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let mut connection =
                connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
            create_node(&mut connection, create_input(NODE_ID, None, None, "Parent"))
                .expect("parent");
            let context = history_context(1, "create");
            journal(&mut connection, &context, |connection| {
                create_node(
                    connection,
                    create_input(CHILD_ID, Some(NODE_ID), None, "Child"),
                )
            })
            .expect("child");
            undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("remove child");
            match lifecycle {
                "archive" => {
                    archive_node(&mut connection, NODE_ID).expect("archive parent");
                }
                _ => {
                    soft_delete_node(&mut connection, NODE_ID).expect("trash parent");
                }
            }

            let error = redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
                .expect_err("redo under inactive parent must conflict");

            assert!(
                error.to_lowercase().contains("history conflict"),
                "{lifecycle}: {error}"
            );
            let child_exists: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM notes_nodes WHERE id = ?1)",
                    [CHILD_ID],
                    |row| row.get(0),
                )
                .expect("child existence");
            assert!(!child_exists, "{lifecycle} replay created a child");
        }
    }

    #[test]
    fn notes_history_older_undo_cannot_make_parent_inactive_above_newer_live_child() {
        for lifecycle in ["trash", "archive"] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let mut connection =
                connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
            create_node(&mut connection, create_input(NODE_ID, None, None, "Parent"))
                .expect("parent");
            match lifecycle {
                "trash" => {
                    soft_delete_node(&mut connection, NODE_ID).expect("trash parent");
                }
                _ => {
                    archive_node(&mut connection, NODE_ID).expect("archive parent");
                }
            }

            let session_a = history_context(1, lifecycle);
            journal(&mut connection, &session_a, |connection| match lifecycle {
                "trash" => restore_node(connection, NODE_ID),
                _ => unarchive_node(connection, NODE_ID),
            })
            .expect("session A activates parent");
            let session_b = history_context_for_session(SECOND_SESSION_ID, 2, "create");
            journal(&mut connection, &session_b, |connection| {
                create_node(
                    connection,
                    create_input(CHILD_ID, Some(NODE_ID), None, "Newer child"),
                )
            })
            .expect("session B child");
            let before_replay = active(&connection);

            let error = undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
                .expect_err("older undo must preserve newer live descendant");

            assert!(
                error.to_lowercase().contains("history conflict"),
                "{lifecycle}: {error}"
            );
            assert_eq!(active(&connection), before_replay);
            let parent_state: (Option<String>, Option<String>) = connection
                .query_row(
                    "SELECT deleted_at, archived_at FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("parent state");
            assert_eq!(parent_state, (None, None));
        }
    }

    #[test]
    fn notes_history_global_entry_limit_cannot_be_bypassed_with_many_sessions() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        create_node(&mut connection, create_input(NODE_ID, None, None, "Root")).expect("root");

        for index in 1..=101 {
            let session_id = format!("10000000-0000-4000-8000-{index:012x}");
            let context = history_context_for_session(&session_id, index, "star");
            journal(&mut connection, &context, |connection| {
                toggle_star(connection, NODE_ID)
            })
            .expect("cross-session toggle");
        }

        assert_eq!(entry_count(&connection), HISTORY_MAX_ENTRIES);
        let oldest_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notes_history_entries WHERE id = ?1)",
                [
                    history_context_for_session("10000000-0000-4000-8000-000000000001", 1, "star")
                        .entry_id,
                ],
                |row| row.get(0),
            )
            .expect("oldest global entry");
        assert!(!oldest_exists);
    }

    #[test]
    fn notes_history_rejects_coalescing_across_an_intervening_session_mutation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        create_node(&mut connection, create_input(NODE_ID, None, None, "Before")).expect("seed");
        let first = history_context(1, "updateText");
        journal(&mut connection, &first, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: "Session A".to_string(),
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect("session A update");
        let second = history_context_for_session(SECOND_SESSION_ID, 2, "updateText");
        journal(&mut connection, &second, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: "Session B".to_string(),
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect("session B update");

        let error = journal(&mut connection, &first, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: "Session A late burst".to_string(),
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect_err("intervening history must close the old coalescing entry");

        assert!(error.contains("latest applied entry"), "{error}");
        assert_eq!(active(&connection).nodes[0].title, "Session B");
    }

    #[test]
    fn notes_history_enforces_one_hundred_entry_limit_and_fifty_mib_payload_limit() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        create_node(&mut connection, create_input(NODE_ID, None, None, "Root")).expect("root");
        assert_eq!(HISTORY_MAX_ENTRIES, 100);
        assert_eq!(HISTORY_MAX_BYTES, 50 * 1024 * 1024);

        for index in 1..=101 {
            let context = history_context(index, "star");
            journal(&mut connection, &context, |connection| {
                toggle_star(connection, NODE_ID)
            })
            .expect("toggle");
        }
        assert_eq!(entry_count(&connection), 100);
        let oldest_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notes_history_entries WHERE id = ?1)",
                [history_context(1, "star").entry_id],
                |row| row.get(0),
            )
            .expect("oldest exists");
        assert!(!oldest_exists);

        clear_history(&mut connection, SESSION_ID).expect("clear entry limit history");
        let large_before = "a".repeat(13 * 1024 * 1024);
        let large_middle = "b".repeat(13 * 1024 * 1024);
        let large_after = "c".repeat(13 * 1024 * 1024);
        update_node(
            &mut connection,
            UpdateNodeInput {
                id: NODE_ID.to_string(),
                title: large_before,
                note: String::new(),
                image_offset_utf16: 0,
            },
        )
        .expect("large seed");
        let context = history_context(200, "updateText");
        journal(&mut connection, &context, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: large_middle,
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect("first large update");
        let second_context = history_context_for_session(SECOND_SESSION_ID, 201, "updateText");
        journal(&mut connection, &second_context, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: large_after,
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect("second large update");
        assert_eq!(
            entry_count(&connection),
            1,
            "combined cross-session payload above the ceiling evicts the oldest entry"
        );
        let estimated_bytes: i64 = connection
            .query_row(
                "SELECT COALESCE(SUM(estimated_bytes), 0) FROM notes_history_entries",
                [],
                |row| row.get(0),
            )
            .expect("global estimated bytes");
        assert!(estimated_bytes <= HISTORY_MAX_BYTES);
        assert!(
            !history_status(&connection, SESSION_ID)
                .expect("evicted first session status")
                .can_undo
        );
        assert!(
            history_status(&connection, SECOND_SESSION_ID)
                .expect("retained second session status")
                .can_undo
        );
    }

    #[test]
    fn notes_history_rejects_oversized_single_entry_without_mutation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        let large_body = "a".repeat((HISTORY_MAX_BYTES / 2) as usize);
        let original_title = format!("Before #before 07/11/2026 {large_body}");
        create_node(
            &mut connection,
            create_input(NODE_ID, None, None, &original_title),
        )
        .expect("seed oversized-history node");
        let replacement_title = format!(
            "After #after 07/12/2026 {}",
            "b".repeat((HISTORY_MAX_BYTES / 2) as usize)
        );
        let context = history_context(1, "updateText");

        let result = journal(&mut connection, &context, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: replacement_title,
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        });
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("one history entry above 50 MiB must reject its mutation"),
        };

        assert_eq!(error, "A Notes history entry cannot exceed 50 MiB.");
        let workspace = active(&connection);
        let node = workspace
            .nodes
            .iter()
            .find(|node| node.id == NODE_ID)
            .expect("rolled-back node");
        assert_eq!(node.title, original_title);
        assert_eq!(
            list_tags(&connection).expect("rolled-back tags"),
            vec!["before".to_string()]
        );
        let search_title: String = connection
            .query_row(
                "SELECT substr(title, 1, 6) FROM notes_search WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("rolled-back search row");
        assert_eq!(search_title, "Before");
        let date_token: String = connection
            .query_row(
                "SELECT token_text FROM notes_dates WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("rolled-back date row");
        assert_eq!(date_token, "07/11/2026");
        assert_eq!(entry_count(&connection), 0);
    }

    #[test]
    fn notes_history_session_clear_connection_locality_and_permanent_operations_are_explicit() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_str().expect("path");
        let mut connection = connect_notes_db(vault_path).expect("connect");
        create_node(&mut connection, create_input(NODE_ID, None, None, "Root")).expect("root");
        let context = history_context(1, "trash");
        journal(&mut connection, &context, |connection| {
            soft_delete_node(connection, NODE_ID)
        })
        .expect("trash");
        let cleared = clear_history(&mut connection, SESSION_ID).expect("clear");
        assert!(!cleared.can_undo);
        assert!(!cleared.can_redo);
        assert_eq!(
            cleared.history_epoch,
            history_epoch(&connection).expect("epoch")
        );
        assert_eq!(entry_count(&connection), 0);

        let context = history_context(2, "restore");
        journal(&mut connection, &context, |connection| {
            restore_node(connection, NODE_ID)
        })
        .expect("restore");
        crate::notes::commands::notes_initialize_inner(vault_path.to_string())
            .expect("expire sessions at initialize");
        assert_eq!(
            entry_count(&connection),
            1,
            "a separate initialization cannot access connection-local history"
        );

        let context = history_context(3, "trash");
        journal(&mut connection, &context, |connection| {
            soft_delete_node(connection, NODE_ID)
        })
        .expect("trash again");
        empty_trash(&mut connection).expect("permanent empty trash");
        assert_eq!(
            entry_count(&connection),
            0,
            "empty trash must invalidate resurrection history"
        );
        assert!(load_workspace(&connection, NotesWorkspaceScope::Trash)
            .expect("trash")
            .nodes
            .is_empty());
        drop(connection);
        delete_database(vault_path).expect("delete database");
        assert!(!crate::notes::repository::notes_db_path(vault_path).exists());
    }

    fn run_delta_mutation(
        connection: &mut Connection,
        context: &NotesHistoryContext,
        operation: impl FnOnce(&mut Connection) -> Result<NotesWorkspace, String>,
    ) -> NotesMutationResult {
        with_history_transaction_and_prunes(connection, Some(context), operation)
            .expect("delta mutation")
            .into_mutation_result()
    }

    fn sorted<T: Clone + Ord>(values: &[T]) -> Vec<T> {
        let mut owned = values.to_vec();
        owned.sort();
        owned
    }

    /// The session `notes_history_changes` rows for an entry are exactly the
    /// compacted audit rows the delta is derived from, so they are the ground
    /// truth for the equivalence assertions below.
    fn persisted_change_ids(
        connection: &Connection,
        entry_id: &str,
    ) -> (Vec<String>, Vec<String>, Vec<String>) {
        let mut statement = connection
            .prepare(
                "SELECT table_name, row_id, after_json FROM notes_history_changes \
                 WHERE entry_id = ?1",
            )
            .expect("prepare persisted changes");
        let rows = statement
            .query_map([entry_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .expect("query persisted changes")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect persisted changes");
        let mut changed_nodes = Vec::new();
        let mut removed_nodes = Vec::new();
        let mut changed_attachments = Vec::new();
        for (table_name, row_id, after_json) in rows {
            match (table_name.as_str(), after_json.is_some()) {
                ("notes_nodes", true) => changed_nodes.push(row_id),
                ("notes_nodes", false) => removed_nodes.push(row_id),
                ("notes_attachments", true) => changed_attachments.push(row_id),
                _ => {}
            }
        }
        (
            sorted(&changed_nodes),
            sorted(&removed_nodes),
            sorted(&changed_attachments),
        )
    }

    fn assert_delta_matches_persisted_audit(
        connection: &Connection,
        entry_id: &str,
        result: &NotesMutationResult,
    ) {
        let changed_node_ids = sorted(
            &result
                .changed_nodes
                .as_ref()
                .expect("changed nodes present")
                .iter()
                .map(|node| node.id.clone())
                .collect::<Vec<_>>(),
        );
        let removed_node_ids = sorted(result.removed_node_ids.as_ref().expect("removed node ids"));
        let changed_attachment_ids = sorted(
            &result
                .changed_attachments
                .as_ref()
                .expect("changed attachments present")
                .iter()
                .map(|attachment| attachment.id.clone())
                .collect::<Vec<_>>(),
        );
        let (expected_changed, expected_removed, expected_attachments) =
            persisted_change_ids(connection, entry_id);
        assert_eq!(changed_node_ids, expected_changed);
        assert_eq!(removed_node_ids, expected_removed);
        assert_eq!(changed_attachment_ids, expected_attachments);
    }

    #[test]
    fn mutation_deltas_match_the_audit_rows_for_each_command_kind() {
        const SPLIT_ID: &str = "44444444-4444-4444-8444-444444444444";
        const MOVE_PARENT: &str = "55555555-5555-4555-8555-555555555555";
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");

        let create_root = history_context(1, "createNode");
        let result = run_delta_mutation(&mut connection, &create_root, |connection| {
            create_node(connection, create_input(NODE_ID, None, None, "Root"))
        });
        assert_delta_matches_persisted_audit(&connection, &create_root.entry_id, &result);
        assert!(result
            .changed_nodes
            .as_ref()
            .unwrap()
            .iter()
            .any(|node| node.id == NODE_ID && node.title == "Root"));
        assert!(result.removed_node_ids.as_ref().unwrap().is_empty());
        assert!(result.changed_attachments.as_ref().unwrap().is_empty());

        let create_child = history_context(2, "createNode");
        let result = run_delta_mutation(&mut connection, &create_child, |connection| {
            create_node(
                connection,
                create_input(CHILD_ID, Some(NODE_ID), None, "Child"),
            )
        });
        assert_delta_matches_persisted_audit(&connection, &create_child.entry_id, &result);

        let update_child = history_context(3, "updateNode");
        let result = run_delta_mutation(&mut connection, &update_child, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: CHILD_ID.to_string(),
                    title: "Renamed".to_string(),
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        });
        assert_delta_matches_persisted_audit(&connection, &update_child.entry_id, &result);
        assert_eq!(
            result
                .changed_nodes
                .as_ref()
                .unwrap()
                .iter()
                .find(|node| node.id == CHILD_ID)
                .expect("updated child in delta")
                .title,
            "Renamed"
        );

        let toggle = history_context(4, "toggleComplete");
        let result = run_delta_mutation(&mut connection, &toggle, |connection| {
            toggle_complete(connection, CHILD_ID)
        });
        assert_delta_matches_persisted_audit(&connection, &toggle.entry_id, &result);
        assert!(result
            .changed_nodes
            .as_ref()
            .unwrap()
            .iter()
            .find(|node| node.id == CHILD_ID)
            .expect("completed child in delta")
            .completed_at
            .is_some());

        let split = history_context(5, "splitNode");
        let result = run_delta_mutation(&mut connection, &split, |connection| {
            split_node(
                connection,
                SplitNodeInput {
                    id: CHILD_ID.to_string(),
                    new_node_id: SPLIT_ID.to_string(),
                    prefix: "Re".to_string(),
                    suffix: "named".to_string(),
                },
            )
        });
        assert_delta_matches_persisted_audit(&connection, &split.entry_id, &result);
        assert!(result
            .changed_nodes
            .as_ref()
            .unwrap()
            .iter()
            .any(|node| node.id == SPLIT_ID));

        let create_parent = history_context(6, "createNode");
        run_delta_mutation(&mut connection, &create_parent, |connection| {
            create_node(
                connection,
                create_input(MOVE_PARENT, None, Some(NODE_ID), "Second root"),
            )
        });
        let move_child = history_context(7, "moveNode");
        let result = run_delta_mutation(&mut connection, &move_child, |connection| {
            move_node(
                connection,
                MoveNodeInput {
                    id: CHILD_ID.to_string(),
                    parent_id: Some(MOVE_PARENT.to_string()),
                    after_id: None,
                    before_id: None,
                },
            )
        });
        assert_delta_matches_persisted_audit(&connection, &move_child.entry_id, &result);
        assert_eq!(
            result
                .changed_nodes
                .as_ref()
                .unwrap()
                .iter()
                .find(|node| node.id == CHILD_ID)
                .expect("moved child in delta")
                .parent_id
                .as_deref(),
            Some(MOVE_PARENT)
        );

        let trash = history_context(8, "softDelete");
        let result = run_delta_mutation(&mut connection, &trash, |connection| {
            soft_delete_node(connection, CHILD_ID)
        });
        assert_delta_matches_persisted_audit(&connection, &trash.entry_id, &result);
        assert!(
            result
                .changed_nodes
                .as_ref()
                .unwrap()
                .iter()
                .find(|node| node.id == CHILD_ID)
                .expect("soft-deleted child appears as an update, not a removal")
                .deleted_at
                .is_some(),
            "a soft delete is an UPDATE, so the row belongs in changedNodes"
        );
        assert!(result.removed_node_ids.as_ref().unwrap().is_empty());

        let restore = history_context(9, "restore");
        let result = run_delta_mutation(&mut connection, &restore, |connection| {
            restore_node(connection, CHILD_ID)
        });
        assert_delta_matches_persisted_audit(&connection, &restore.entry_id, &result);
        assert!(result
            .changed_nodes
            .as_ref()
            .unwrap()
            .iter()
            .find(|node| node.id == CHILD_ID)
            .expect("restored child in delta")
            .deleted_at
            .is_none());
    }

    #[test]
    fn attachment_mutation_delta_reports_created_attachments() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        create_node(&mut connection, create_input(NODE_ID, None, None, "Root")).expect("root");

        let import = history_context(1, "importAttachment");
        let attachment = history_new_attachment(70_000, NODE_ID);
        let attachment_id = attachment.id.clone();
        let result = run_delta_mutation(&mut connection, &import, |connection| {
            create_attachment(connection, attachment)
        });
        assert_delta_matches_persisted_audit(&connection, &import.entry_id, &result);
        assert_eq!(
            result
                .changed_attachments
                .as_ref()
                .unwrap()
                .iter()
                .map(|attachment| attachment.id.clone())
                .collect::<Vec<_>>(),
            vec![attachment_id]
        );
        assert!(result.changed_nodes.as_ref().unwrap().is_empty());
        assert!(result.removed_node_ids.as_ref().unwrap().is_empty());
    }

    #[test]
    fn notes_history_missing_context_rejects_before_the_mutation_closure() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        let entered = std::cell::Cell::new(false);

        let result = with_history_transaction_and_prunes(&mut connection, None, |connection| {
            entered.set(true);
            create_node(connection, create_input(NODE_ID, None, None, "Root"))
        });
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("missing history context must reject"),
        };

        assert!(error.to_lowercase().contains("history context"), "{error}");
        assert!(!entered.get(), "missing context entered mutation closure");
        assert!(active(&connection)
            .nodes
            .iter()
            .all(|node| node.id != NODE_ID));
    }

    fn node_audit_json(id: &str, title: &str, is_collapsed: i64, is_starred: i64) -> String {
        format!(
            "{{\"id\":\"{id}\",\"parent_id\":null,\"sort_key\":1024,\"title\":\"{title}\",\
              \"note\":\"\",\"image_offset_utf16\":0,\"layout_mode\":\"bullets\",\"is_collapsed\":{is_collapsed},\
              \"is_starred\":{is_starred},\"completed_at\":null,\
              \"created_at\":\"2026-07-10T00:00:00.000Z\",\
              \"updated_at\":\"2026-07-10T00:00:00.000Z\",\"deleted_at\":null,\
              \"deleted_batch_id\":null,\"archived_at\":null,\"archive_root_id\":null,\
              \"nodeKind\":\"text\"}}"
        )
    }

    fn attachment_audit_json(id: &str, node_id: &str) -> String {
        let hash = "a".repeat(64);
        format!(
            "{{\"id\":\"{id}\",\"node_id\":\"{node_id}\",\"sort_key\":1024,\
              \"relative_path\":\"notes-assets/{hash}.png\",\"content_hash\":\"{hash}\",\
              \"original_name\":\"image.png\",\"mime_type\":\"image/png\",\"byte_size\":1,\
              \"intrinsic_width\":1,\"intrinsic_height\":1,\"display_width\":1,\
              \"created_at\":\"2026-07-10T00:00:00.000Z\",\
              \"updated_at\":\"2026-07-10T00:00:00.000Z\"}}"
        )
    }

    fn insert_audit_row(
        connection: &Connection,
        table_name: &str,
        row_id: &str,
        ordinal: i64,
        before_json: Option<&str>,
        after_json: Option<&str>,
    ) {
        connection
            .execute(
                "INSERT INTO notes_history_audit(table_name, row_id, ordinal, before_json, after_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![table_name, row_id, ordinal, before_json, after_json],
            )
            .expect("insert audit row");
    }

    #[test]
    fn read_mutation_delta_classifies_audit_rows_and_skips_no_ops() {
        const FOURTH_ID: &str = "44444444-4444-4444-8444-444444444444";
        let connection = Connection::open_in_memory().expect("memory db");
        connection
            .execute_batch(
                "CREATE TEMP TABLE notes_history_audit (\
                   table_name TEXT NOT NULL, row_id TEXT NOT NULL, ordinal INTEGER NOT NULL, \
                   before_json TEXT, after_json TEXT, \
                   PRIMARY KEY (table_name, row_id));",
            )
            .expect("audit table");

        let changed_node = node_audit_json(NODE_ID, "Root", 0, 1);
        let removed_before = node_audit_json(CHILD_ID, "Gone", 0, 0);
        let noop = node_audit_json(THIRD_ID, "Same", 0, 0);
        let changed_attachment = attachment_audit_json("attachment-changed", NODE_ID);
        let removed_attachment = attachment_audit_json("attachment-removed", NODE_ID);

        // Created/updated node: keeps its full payload.
        insert_audit_row(
            &connection,
            "notes_nodes",
            NODE_ID,
            1,
            None,
            Some(&changed_node),
        );
        // Hard-deleted node: surfaced as a removed id.
        insert_audit_row(
            &connection,
            "notes_nodes",
            CHILD_ID,
            2,
            Some(&removed_before),
            None,
        );
        // No-op update (before == after): skipped.
        insert_audit_row(
            &connection,
            "notes_nodes",
            THIRD_ID,
            3,
            Some(&noop),
            Some(&noop),
        );
        // Created-then-deleted within the mutation (before == after == NULL): skipped.
        insert_audit_row(&connection, "notes_nodes", FOURTH_ID, 4, None, None);
        // Created/updated attachment: surfaced.
        insert_audit_row(
            &connection,
            "notes_attachments",
            "attachment-changed",
            5,
            None,
            Some(&changed_attachment),
        );
        // Removed attachment: intentionally not surfaced by the delta contract.
        insert_audit_row(
            &connection,
            "notes_attachments",
            "attachment-removed",
            6,
            Some(&removed_attachment),
            None,
        );

        let delta = super::read_mutation_delta(&connection).expect("mutation delta");
        assert_eq!(
            delta
                .changed_nodes
                .iter()
                .map(|node| node.id.clone())
                .collect::<Vec<_>>(),
            vec![NODE_ID.to_string()]
        );
        assert_eq!(delta.removed_node_ids, vec![CHILD_ID.to_string()]);
        assert_eq!(
            delta
                .changed_attachments
                .iter()
                .map(|attachment| attachment.id.clone())
                .collect::<Vec<_>>(),
            vec!["attachment-changed".to_string()]
        );
        assert_eq!(delta.changed_nodes[0].title, "Root");
        assert!(delta.changed_nodes[0].is_starred);
        assert_eq!(delta.changed_attachments[0].node_id, NODE_ID);
    }

    #[test]
    fn notes_history_replay_rejects_wrong_expected_id_without_changing_rows() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        create_node(&mut connection, create_input(NODE_ID, None, None, "Before")).expect("seed");
        let epoch = history_epoch(&connection).expect("epoch");
        let first = NotesHistoryContext {
            history_epoch: epoch.clone(),
            ..history_context(1, "updateText")
        };
        let second = NotesHistoryContext {
            history_epoch: epoch.clone(),
            ..history_context(2, "updateText")
        };
        for (context, title) in [(&first, "First"), (&second, "Second")] {
            journal(&mut connection, context, |connection| {
                update_node(
                    connection,
                    UpdateNodeInput {
                        id: NODE_ID.to_string(),
                        title: title.to_string(),
                        note: String::new(),
                        image_offset_utf16: 0,
                    },
                )
            })
            .expect("journal update");
        }
        let before = active(&connection);

        let outcome = undo_expected(
            &mut connection,
            SESSION_ID,
            &epoch,
            &first.entry_id,
            NotesWorkspaceScope::Active,
        )
        .expect("replay outcome");

        assert!(matches!(
            outcome,
            NotesHistoryReplayOutcome::EntryNotNext { .. }
        ));
        assert_eq!(active(&connection), before);
        assert_eq!(
            history_state(&connection, SESSION_ID, Vec::new())
                .expect("state")
                .next_undo_entry_id
                .as_deref(),
            Some(second.entry_id.as_str())
        );
    }

    #[test]
    fn notes_history_replay_returns_epoch_and_missing_outcomes_without_mutation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        create_node(&mut connection, create_input(NODE_ID, None, None, "Before")).expect("seed");
        let epoch = history_epoch(&connection).expect("epoch");
        let context = NotesHistoryContext {
            history_epoch: epoch.clone(),
            ..history_context(1, "updateText")
        };
        journal(&mut connection, &context, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: "After".to_string(),
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect("journal update");
        let before = active(&connection);

        let stale = undo_expected(
            &mut connection,
            SESSION_ID,
            "stale-epoch",
            "not-an-entry-id",
            NotesWorkspaceScope::Active,
        )
        .expect("stale replay outcome");
        assert!(matches!(
            stale,
            NotesHistoryReplayOutcome::EpochMismatch { .. }
        ));
        assert_eq!(active(&connection), before);
        assert_eq!(
            history_state(&connection, SESSION_ID, Vec::new())
                .expect("state after stale replay")
                .next_undo_entry_id
                .as_deref(),
            Some(context.entry_id.as_str())
        );

        undo_expected(
            &mut connection,
            SESSION_ID,
            &epoch,
            &context.entry_id,
            NotesWorkspaceScope::Active,
        )
        .expect("apply exact undo");
        let undone = active(&connection);
        let missing = undo_expected(
            &mut connection,
            SESSION_ID,
            &epoch,
            "not-an-entry-id",
            NotesWorkspaceScope::Active,
        )
        .expect("missing replay outcome");
        assert!(matches!(
            missing,
            NotesHistoryReplayOutcome::EntryMissing { .. }
        ));
        assert_eq!(active(&connection), undone);
        assert_eq!(entry_count(&connection), 1);
    }

    #[test]
    fn notes_history_stale_epoch_mutation_changes_no_live_rows() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        create_node(&mut connection, create_input(NODE_ID, None, None, "Before")).expect("seed");
        let before = active(&connection);
        let stale = NotesHistoryContext {
            history_epoch: "stale-epoch".to_string(),
            ..history_context(1, "updateText")
        };

        let error = journal(&mut connection, &stale, |connection| {
            update_node(
                connection,
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: "After".to_string(),
                    note: String::new(),
                    image_offset_utf16: 0,
                },
            )
        })
        .expect_err("stale epoch");

        assert!(error.to_lowercase().contains("epoch"), "{error}");
        assert_eq!(active(&connection), before);
        assert_eq!(entry_count(&connection), 0);
    }

    #[test]
    fn notes_history_new_mutation_reports_all_invalidated_redo_ids() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        create_node(&mut connection, create_input(NODE_ID, None, None, "Before")).expect("seed");
        let epoch = history_epoch(&connection).expect("epoch");
        let first = NotesHistoryContext {
            history_epoch: epoch.clone(),
            ..history_context(1, "updateText")
        };
        let second = NotesHistoryContext {
            history_epoch: epoch.clone(),
            ..history_context(2, "updateText")
        };
        for (context, title) in [(&first, "First"), (&second, "Second")] {
            journal(&mut connection, context, |connection| {
                update_node(
                    connection,
                    UpdateNodeInput {
                        id: NODE_ID.to_string(),
                        title: title.to_string(),
                        note: String::new(),
                        image_offset_utf16: 0,
                    },
                )
            })
            .expect("journal update");
        }
        for entry_id in [&second.entry_id, &first.entry_id] {
            undo_expected(
                &mut connection,
                SESSION_ID,
                &epoch,
                entry_id,
                NotesWorkspaceScope::Active,
            )
            .expect("undo entry");
        }
        let replacement = NotesHistoryContext {
            history_epoch: epoch,
            ..history_context(3, "updateText")
        };

        let result = with_history_transaction_and_prunes(
            &mut connection,
            Some(&replacement),
            |connection| {
                update_node(
                    connection,
                    UpdateNodeInput {
                        id: NODE_ID.to_string(),
                        title: "Replacement".to_string(),
                        note: String::new(),
                        image_offset_utf16: 0,
                    },
                )
            },
        )
        .expect("replacement mutation");

        assert_eq!(
            result.state.pruned_entry_ids,
            vec![first.entry_id, second.entry_id]
        );
    }

    #[test]
    fn notes_history_prepare_navigation_requires_the_complete_ordered_redo_suffix() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        create_node(&mut connection, create_input(NODE_ID, None, None, "Before")).expect("seed");
        let epoch = history_epoch(&connection).expect("epoch");
        let foreign = NotesHistoryContext {
            history_epoch: epoch.clone(),
            ..history_context_for_session(SECOND_SESSION_ID, 9, "toggleStar")
        };
        journal(&mut connection, &foreign, |connection| {
            toggle_star(connection, NODE_ID)
        })
        .expect("journal foreign-session entry");
        let contexts = (1..=3)
            .map(|index| NotesHistoryContext {
                history_epoch: epoch.clone(),
                ..history_context(index, "updateText")
            })
            .collect::<Vec<_>>();
        for (context, title) in contexts.iter().zip(["First", "Second", "Third"]) {
            journal(&mut connection, context, |connection| {
                update_node(
                    connection,
                    UpdateNodeInput {
                        id: NODE_ID.to_string(),
                        title: title.to_string(),
                        note: String::new(),
                        image_offset_utf16: 0,
                    },
                )
            })
            .expect("journal session entry");
        }
        for context in contexts[1..].iter().rev() {
            undo_expected(
                &mut connection,
                SESSION_ID,
                &epoch,
                &context.entry_id,
                NotesWorkspaceScope::Active,
            )
            .expect("undo redo-suffix entry");
        }
        let snapshot = |connection: &Connection| {
            let entries = connection
                .prepare(
                    "SELECT id, session_id, sequence, is_undone FROM notes_history_entries \
                     ORDER BY rowid, id",
                )
                .expect("prepare history snapshot")
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, bool>(3)?,
                    ))
                })
                .expect("query history snapshot")
                .collect::<Result<Vec<_>, _>>()
                .expect("collect history snapshot");
            let changes: i64 = connection
                .query_row("SELECT COUNT(*) FROM notes_history_changes", [], |row| {
                    row.get(0)
                })
                .expect("count history changes");
            (entries, changes)
        };
        let before = snapshot(&connection);
        let applied = contexts[0].entry_id.clone();
        let suffix = contexts[1..]
            .iter()
            .map(|context| context.entry_id.clone())
            .collect::<Vec<_>>();
        let rejected = [
            ("empty", Vec::new()),
            ("foreign", vec![foreign.entry_id.clone()]),
            ("applied", vec![applied.clone()]),
            ("partial", vec![suffix[0].clone()]),
            ("extra", vec![applied, suffix[0].clone(), suffix[1].clone()]),
            ("reordered", vec![suffix[1].clone(), suffix[0].clone()]),
        ];

        for (label, unreachable_redo_entry_ids) in rejected {
            prepare_navigation(
                &mut connection,
                &NotesPrepareNavigationInput {
                    session_id: SESSION_ID.to_string(),
                    history_epoch: epoch.clone(),
                    unreachable_redo_entry_ids,
                },
            )
            .expect_err(label);
            assert_eq!(snapshot(&connection), before, "{label} changed history");
        }

        let pruned = prepare_navigation(
            &mut connection,
            &NotesPrepareNavigationInput {
                session_id: SESSION_ID.to_string(),
                history_epoch: epoch,
                unreachable_redo_entry_ids: suffix.clone(),
            },
        )
        .expect("prune exact ordered redo suffix");
        assert_eq!(pruned.state.pruned_entry_ids, suffix);
        assert!(!pruned.state.can_redo);
    }

    #[test]
    fn notes_history_prune_validates_epoch_and_ownership_before_deleting_entries() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection = connect_empty_history_db(temp_dir.path().to_str().expect("path"));
        create_node(&mut connection, create_input(NODE_ID, None, None, "Before")).expect("seed");
        let epoch = history_epoch(&connection).expect("epoch");
        let foreign = NotesHistoryContext {
            history_epoch: epoch.clone(),
            ..history_context_for_session(SECOND_SESSION_ID, 9, "toggleStar")
        };
        journal(&mut connection, &foreign, |connection| {
            toggle_star(connection, NODE_ID)
        })
        .expect("journal foreign entry");
        let first = NotesHistoryContext {
            history_epoch: epoch.clone(),
            ..history_context(1, "updateText")
        };
        let second = NotesHistoryContext {
            history_epoch: epoch.clone(),
            ..history_context(2, "updateText")
        };
        for (context, title) in [(&first, "First"), (&second, "Second")] {
            journal(&mut connection, context, |connection| {
                update_node(
                    connection,
                    UpdateNodeInput {
                        id: NODE_ID.to_string(),
                        title: title.to_string(),
                        note: String::new(),
                        image_offset_utf16: 0,
                    },
                )
            })
            .expect("journal owned entry");
        }
        let before = entry_count(&connection);
        for (label, history_epoch, entry_ids) in [
            (
                "stale",
                "stale-epoch".to_string(),
                vec![first.entry_id.clone()],
            ),
            ("foreign", epoch.clone(), vec![foreign.entry_id.clone()]),
        ] {
            prune_history_entries(
                &mut connection,
                &NotesPruneHistoryInput {
                    session_id: SESSION_ID.to_string(),
                    history_epoch,
                    entry_ids,
                },
            )
            .expect_err(label);
            assert_eq!(entry_count(&connection), before, "{label} pruned history");
        }

        let pruned = prune_history_entries(
            &mut connection,
            &NotesPruneHistoryInput {
                session_id: SESSION_ID.to_string(),
                history_epoch: epoch,
                entry_ids: vec![first.entry_id.clone()],
            },
        )
        .expect("prune owned history entry");
        assert_eq!(pruned.state.pruned_entry_ids, vec![first.entry_id]);
        assert_eq!(pruned.state.next_undo_entry_id, Some(second.entry_id));
        assert_eq!(entry_count(&connection), before - 1);
    }
}
