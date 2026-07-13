use crate::notes::attachments::AttachmentStorageLease;
use crate::notes::date_index::{LocalDate, LocalTodayProvider, SystemLocalTodayProvider};
use crate::notes::repository::{load_workspace, rebuild_derived_for_nodes_at};
use crate::notes::types::{
    validate_note_id, NoteAttachment, NotesHistoryContext, NotesHistoryReplayResult,
    NotesHistoryStatus, NotesMutationResult, NotesWorkspace, NotesWorkspaceScope,
    MAX_NOTE_ATTACHMENTS_PER_NODE, MAX_NOTE_ATTACHMENTS_PER_VAULT,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Deserialize;
use std::collections::{BTreeSet, HashMap};

pub(crate) const HISTORY_MAX_ENTRIES: i64 = 100;
pub(crate) const HISTORY_MAX_BYTES: i64 = 50 * 1024 * 1024;

const NODE_JSON_NEW: &str = "json_object(\
  'id', NEW.id, 'parent_id', NEW.parent_id, 'sort_key', NEW.sort_key, \
  'title', NEW.title, 'note', NEW.note, 'layout_mode', NEW.layout_mode, \
  'is_collapsed', NEW.is_collapsed, 'is_starred', NEW.is_starred, \
  'completed_at', NEW.completed_at, 'created_at', NEW.created_at, \
  'updated_at', NEW.updated_at, 'deleted_at', NEW.deleted_at, \
  'deleted_batch_id', NEW.deleted_batch_id, 'archived_at', NEW.archived_at, \
  'archive_root_id', NEW.archive_root_id)";
const NODE_JSON_OLD: &str = "json_object(\
  'id', OLD.id, 'parent_id', OLD.parent_id, 'sort_key', OLD.sort_key, \
  'title', OLD.title, 'note', OLD.note, 'layout_mode', OLD.layout_mode, \
  'is_collapsed', OLD.is_collapsed, 'is_starred', OLD.is_starred, \
  'completed_at', OLD.completed_at, 'created_at', OLD.created_at, \
  'updated_at', OLD.updated_at, 'deleted_at', OLD.deleted_at, \
  'deleted_batch_id', OLD.deleted_batch_id, 'archived_at', OLD.archived_at, \
  'archive_root_id', OLD.archive_root_id)";
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

fn validate_context(context: &NotesHistoryContext) -> Result<(), String> {
    validate_history_id("Notes history session ID", &context.session_id)?;
    validate_history_id("Notes history entry ID", &context.entry_id)?;
    let command_kind = context.command_kind.trim();
    if command_kind.is_empty() || command_kind.len() > 128 {
        return Err("Notes history command kind must contain 1 to 128 characters.".to_string());
    }
    Ok(())
}

fn install_audit_infrastructure(connection: &Connection) -> Result<(), String> {
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
                  NULL, {NODE_JSON_NEW})
          ON CONFLICT(table_name, row_id) DO UPDATE SET after_json = excluded.after_json;
        END;
        CREATE TEMP TRIGGER IF NOT EXISTS notes_history_nodes_update
        AFTER UPDATE ON notes_nodes
        WHEN EXISTS (SELECT 1 FROM notes_history_context)
        BEGIN
          INSERT INTO notes_history_audit(table_name, row_id, ordinal, before_json, after_json)
          VALUES ('notes_nodes', NEW.id,
                  (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM notes_history_audit),
                  {NODE_JSON_OLD}, {NODE_JSON_NEW})
          ON CONFLICT(table_name, row_id) DO UPDATE SET after_json = excluded.after_json;
        END;
        CREATE TEMP TRIGGER IF NOT EXISTS notes_history_nodes_delete
        AFTER DELETE ON notes_nodes
        WHEN EXISTS (SELECT 1 FROM notes_history_context)
        BEGIN
          INSERT INTO notes_history_audit(table_name, row_id, ordinal, before_json, after_json)
          VALUES ('notes_nodes', OLD.id,
                  (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM notes_history_audit),
                  {NODE_JSON_OLD}, NULL)
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

fn begin_audit(connection: &Connection, context: &NotesHistoryContext) -> Result<(), String> {
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

pub(crate) struct HistoryTransactionResult {
    pub(crate) workspace: NotesWorkspace,
    pub(crate) history_entry_id: Option<String>,
    pub(crate) can_undo: bool,
    pub(crate) can_redo: bool,
    pub(crate) pruned_attachment_paths: Vec<String>,
}

impl HistoryTransactionResult {
    pub(crate) fn into_mutation_result(self) -> NotesMutationResult {
        NotesMutationResult {
            workspace: self.workspace,
            history_entry_id: self.history_entry_id,
            can_undo: self.can_undo,
            can_redo: self.can_redo,
        }
    }
}

pub(crate) fn with_history_transaction_and_prunes(
    connection: &mut Connection,
    context: Option<&NotesHistoryContext>,
    operation: impl FnOnce(&mut Connection) -> Result<NotesWorkspace, String>,
) -> Result<HistoryTransactionResult, String> {
    let Some(context) = context else {
        return operation(connection).map(|workspace| HistoryTransactionResult {
            workspace,
            history_entry_id: None,
            can_undo: false,
            can_redo: false,
            pruned_attachment_paths: Vec::new(),
        });
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
            Ok((paths, mutation))
        })()
    } else {
        Ok((Vec::new(), (None, false, false)))
    };
    let cleanup = end_audit(connection);
    match (result, committed_result, cleanup) {
        (Err(error), _, _) => Err(error),
        (Ok(_), Err(error), _) | (Ok(_), Ok(_), Err(error)) => Err(error),
        (
            Ok(workspace),
            Ok((pruned_attachment_paths, (history_entry_id, can_undo, can_redo))),
            Ok(()),
        ) => Ok(HistoryTransactionResult {
            workspace,
            history_entry_id,
            can_undo,
            can_redo,
            pruned_attachment_paths,
        }),
    }
}

pub(crate) fn with_history_transaction(
    connection: &mut Connection,
    context: Option<&NotesHistoryContext>,
    operation: impl FnOnce(&mut Connection) -> Result<NotesWorkspace, String>,
) -> Result<NotesWorkspace, String> {
    with_history_transaction_and_prunes(connection, context, operation)
        .map(|result| result.workspace)
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
    record_pruned_attachment_paths(
        transaction,
        "SELECT id FROM notes_history_entries WHERE is_undone = 1",
        [],
    )?;
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
    enforce_limits(transaction)?;
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

fn enforce_limits(transaction: &Transaction<'_>) -> Result<(), String> {
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
                "SELECT id FROM notes_history_entries ORDER BY rowid, id LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("Could not choose old Notes history to evict: {error}"))?
            .ok_or_else(|| "Could not enforce Notes history limits.".to_string())?;
        record_pruned_attachment_paths(transaction, "SELECT ?1", [&oldest_entry])?;
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
    validate_history_id("Notes history session ID", session_id)?;
    connection
        .query_row(
            "SELECT \
               EXISTS(SELECT 1 FROM notes_history_entries WHERE session_id = ?1 AND is_undone = 0), \
               EXISTS(SELECT 1 FROM notes_history_entries WHERE session_id = ?1 AND is_undone = 1)",
            [session_id],
            |row| Ok(NotesHistoryStatus { can_undo: row.get(0)?, can_redo: row.get(1)? }),
        )
        .map_err(|error| format!("Could not read Notes history status: {error}"))
}

pub(crate) fn clear_history(
    connection: &mut Connection,
    session_id: &str,
) -> Result<NotesHistoryStatus, String> {
    validate_history_id("Notes history session ID", session_id)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start clearing Notes history: {error}"))?;
    transaction
        .execute(
            "DELETE FROM notes_history_entries WHERE session_id = ?1",
            [session_id],
        )
        .map_err(|error| format!("Could not clear Notes history: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit cleared Notes history: {error}"))?;
    Ok(NotesHistoryStatus::default())
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
    transaction
        .execute("DELETE FROM notes_history_entries", [])
        .map_err(|error| format!("Could not clear all Notes history: {error}"))?;
    Ok(())
}

#[derive(Deserialize)]
struct NodeSnapshot {
    id: String,
    parent_id: Option<String>,
    sort_key: i64,
    title: String,
    note: String,
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
    let (table, alias, expression) = match table_name {
        "notes_nodes" => (
            "notes_nodes",
            "node",
            NODE_JSON_NEW.replace("NEW.", "node."),
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

fn apply_node_state(
    transaction: &Transaction<'_>,
    row_id: &str,
    state: Option<&str>,
) -> Result<(), String> {
    let Some(state) = state else {
        transaction
            .execute("DELETE FROM notes_nodes WHERE id = ?1", [row_id])
            .map_err(|error| {
                format!("Could not remove a Note row during history replay: {error}")
            })?;
        return Ok(());
    };
    let node = decode_node_snapshot(row_id, state)?;
    transaction
        .execute(
            "INSERT INTO notes_nodes(\
               id, parent_id, sort_key, title, note, layout_mode, is_collapsed, is_starred, \
               completed_at, created_at, updated_at, deleted_at, deleted_batch_id, archived_at, archive_root_id\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15) \
             ON CONFLICT(id) DO UPDATE SET \
               parent_id = excluded.parent_id, sort_key = excluded.sort_key, title = excluded.title, \
               note = excluded.note, layout_mode = excluded.layout_mode, is_collapsed = excluded.is_collapsed, \
               is_starred = excluded.is_starred, completed_at = excluded.completed_at, \
               created_at = excluded.created_at, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, \
               deleted_batch_id = excluded.deleted_batch_id, archived_at = excluded.archived_at, \
               archive_root_id = excluded.archive_root_id",
            params![
                node.id, node.parent_id, node.sort_key, node.title, node.note, node.layout_mode,
                node.is_collapsed, node.is_starred, node.completed_at, node.created_at,
                node.updated_at, node.deleted_at, node.deleted_batch_id, node.archived_at,
                node.archive_root_id
            ],
        )
        .map_err(|error| format!("Could not restore a Note row during history replay: {error}"))?;
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

/// Re-reads and fully re-decodes the owned bytes for every attachment the
/// replay would touch, confirming they still match their stored metadata.
/// Runs outside the replay transaction so the slow image decode never holds
/// the write lock (mirrors the PreparedAttachmentBatch pre-transaction decode).
fn validate_replay_attachment_bytes(
    storage: &AttachmentStorageLease,
    changes: &[(String, String, Option<String>, Option<String>)],
    undoing: bool,
) -> Result<(), String> {
    for (table_name, row_id, before_json, after_json) in changes {
        if table_name != "notes_attachments" {
            continue;
        }
        let target = if undoing { before_json } else { after_json };
        if let Some(state) = target {
            let attachment = decode_attachment_snapshot(row_id, state)?;
            storage.read_validated_attachment_bytes(&attachment)?;
        }
    }
    Ok(())
}

fn replay(
    connection: &mut Connection,
    session_id: &str,
    scope: NotesWorkspaceScope,
    undoing: bool,
    attachment_storage: Option<&AttachmentStorageLease>,
    today: LocalDate,
) -> Result<NotesHistoryReplayResult, String> {
    validate_history_id("Notes history session ID", session_id)?;

    // Re-decode every touched attachment's owned bytes BEFORE opening the write
    // transaction. Doing this inside the IMMEDIATE transaction (as before) held
    // the write lock across a full image decode of each attachment; instead we
    // validate against the current, serialized snapshot first — the same entry
    // and change set the transaction below re-reads (note commands are
    // serialized per vault on a single managed connection).
    if let Some(storage) = attachment_storage {
        if let Some(entry_id) = select_replay_entry_id(&*connection, session_id, undoing)? {
            let changes = read_replay_changes(&*connection, &entry_id, undoing)?;
            validate_replay_attachment_bytes(storage, &changes, undoing)?;
        }
    }

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start Notes history replay: {error}"))?;
    let Some(entry_id) = select_replay_entry_id(&transaction, session_id, undoing)? else {
        let workspace = load_workspace(&transaction, scope)?;
        let status = history_status(&transaction, session_id)?;
        transaction
            .commit()
            .map_err(|error| format!("Could not finish empty Notes history replay: {error}"))?;
        return Ok(NotesHistoryReplayResult {
            workspace,
            replayed_entry_id: None,
            can_undo: status.can_undo,
            can_redo: status.can_redo,
        });
    };
    let changes = read_replay_changes(&transaction, &entry_id, undoing)?;
    validate_expected_states(&transaction, &changes, undoing)?;
    validate_target_lifecycle(&transaction, &changes, undoing)?;
    validate_target_attachment_capacity(&transaction, &changes, undoing)?;
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
    let status = history_status(&transaction, session_id)?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit Notes history replay: {error}"))?;
    Ok(NotesHistoryReplayResult {
        workspace,
        replayed_entry_id: Some(entry_id),
        can_undo: status.can_undo,
        can_redo: status.can_redo,
    })
}

#[cfg(test)]
pub(crate) fn undo(
    connection: &mut Connection,
    session_id: &str,
    scope: NotesWorkspaceScope,
) -> Result<NotesHistoryReplayResult, String> {
    let today = SystemLocalTodayProvider.local_today(connection)?;
    replay(connection, session_id, scope, true, None, today)
}

#[cfg(test)]
pub(crate) fn redo(
    connection: &mut Connection,
    session_id: &str,
    scope: NotesWorkspaceScope,
) -> Result<NotesHistoryReplayResult, String> {
    let today = SystemLocalTodayProvider.local_today(connection)?;
    replay(connection, session_id, scope, false, None, today)
}

pub(crate) fn undo_with_attachment_storage(
    connection: &mut Connection,
    session_id: &str,
    scope: NotesWorkspaceScope,
    attachment_storage: &AttachmentStorageLease,
) -> Result<NotesHistoryReplayResult, String> {
    let today = SystemLocalTodayProvider.local_today(connection)?;
    undo_with_attachment_storage_at(connection, session_id, scope, attachment_storage, today)
}

pub(crate) fn undo_with_attachment_storage_at(
    connection: &mut Connection,
    session_id: &str,
    scope: NotesWorkspaceScope,
    attachment_storage: &AttachmentStorageLease,
    today: LocalDate,
) -> Result<NotesHistoryReplayResult, String> {
    replay(
        connection,
        session_id,
        scope,
        true,
        Some(attachment_storage),
        today,
    )
}

pub(crate) fn redo_with_attachment_storage(
    connection: &mut Connection,
    session_id: &str,
    scope: NotesWorkspaceScope,
    attachment_storage: &AttachmentStorageLease,
) -> Result<NotesHistoryReplayResult, String> {
    let today = SystemLocalTodayProvider.local_today(connection)?;
    redo_with_attachment_storage_at(connection, session_id, scope, attachment_storage, today)
}

pub(crate) fn redo_with_attachment_storage_at(
    connection: &mut Connection,
    session_id: &str,
    scope: NotesWorkspaceScope,
    attachment_storage: &AttachmentStorageLease,
    today: LocalDate,
) -> Result<NotesHistoryReplayResult, String> {
    replay(
        connection,
        session_id,
        scope,
        false,
        Some(attachment_storage),
        today,
    )
}

#[cfg(test)]
mod tests {
    use super::{
        clear_history, history_status, redo, undo, with_history_transaction,
        with_history_transaction_and_prunes, HISTORY_MAX_BYTES, HISTORY_MAX_ENTRIES,
    };
    use crate::notes::repository::{
        archive_node, connect_notes_db, create_attachment, create_attachments_coordinated_for_node,
        create_node, delete_database, duplicate_node, empty_trash, list_tags, load_workspace,
        move_node, remove_attachment, restore_node, search_nodes, search_nodes_structured,
        soft_delete_node, split_node, toggle_collapsed, toggle_complete, toggle_star,
        unarchive_node, update_node, NewAttachment,
    };
    use crate::notes::types::{
        CreateNodeInput, MoveNodeInput, NoteSearchTag, NoteStructuredSearchQuery, NoteTagPrefix,
        NotesHistoryContext, NotesWorkspace, NotesWorkspaceScope, SplitNodeInput, UpdateNodeInput,
        MAX_NOTE_ATTACHMENTS_PER_NODE, MAX_NOTE_ATTACHMENTS_PER_VAULT,
    };
    use rusqlite::{params, Connection};

    const NODE_ID: &str = "11111111-1111-4111-8111-111111111111";
    const CHILD_ID: &str = "22222222-2222-4222-8222-222222222222";
    const THIRD_ID: &str = "33333333-3333-4333-8333-333333333333";
    const SESSION_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const SECOND_SESSION_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
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
    fn notes_history_coalesces_text_updates_with_the_same_entry_id() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
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
    fn notes_history_replays_split_and_move_with_sibling_rebalance() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
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
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
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
    fn notes_history_replays_trash_restore_archive_and_unarchive() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
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
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        let has_command_kind: bool = connection
            .query_row(
                "SELECT EXISTS(\
                   SELECT 1 FROM pragma_table_info('notes_history_entries') \
                   WHERE name = 'command_kind'\
                 )",
                [],
                |row| row.get(0),
            )
            .expect("inspect history command kind");
        if !has_command_kind {
            connection
                .execute_batch(
                    "ALTER TABLE notes_history_entries \
                     ADD COLUMN command_kind TEXT NOT NULL;",
                )
                .expect("require history command kind");
        }
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
    fn notes_history_session_clear_expiry_and_permanent_operations_are_explicit() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_str().expect("path");
        let mut connection = connect_notes_db(vault_path).expect("connect");
        create_node(&mut connection, create_input(NODE_ID, None, None, "Root")).expect("root");
        let context = history_context(1, "trash");
        journal(&mut connection, &context, |connection| {
            soft_delete_node(connection, NODE_ID)
        })
        .expect("trash");
        assert_eq!(
            clear_history(&mut connection, SESSION_ID).expect("clear"),
            Default::default()
        );
        assert_eq!(entry_count(&connection), 0);

        let context = history_context(2, "restore");
        journal(&mut connection, &context, |connection| {
            restore_node(connection, NODE_ID)
        })
        .expect("restore");
        crate::notes::commands::notes_initialize_inner(vault_path.to_string())
            .expect("expire sessions at initialize");
        assert_eq!(entry_count(&connection), 0);

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
}
