use crate::file_io::write_atomic_file;
use crate::notes::attachment_ingest::decode_raw_attachment_envelope;
use crate::notes::error::{NotesError, NotesErrorCode};
use crate::notes::attachments::{AttachmentStorageLease, PreparedAttachmentBatch};
use crate::notes::connection::{
    acquire_notes_connection, acquire_vault_app_lock, evict_notes_connection,
    lock_notes_connection, reinitialize_notes_connection,
};
use crate::notes::date_index::{LocalTodayProvider, SystemLocalTodayProvider};
use crate::notes::export::{
    hydrate_export_attachments, load_export_snapshot, markdown_asset_destination,
    preflight_markdown_asset_destination, prepare_markdown_export, publish_markdown_export,
    render_markdown, render_pdf,
};
use crate::notes::history::{
    clear_all_history, clear_history, history_status, redo_with_attachment_storage_at,
    undo_with_attachment_storage_at, with_history_transaction_and_prunes,
};
use crate::notes::repository::{
    apply_batch, archive_node, attachment_by_id, collapse_all,
    create_attachments_coordinated_for_node, create_node_at, delete_database, duplicate_node_at,
    empty_trash, expand_all, list_tags,
    list_tags_with_counts, load_workspace, move_node, open_notes_export_db, remove_attachment,
    remove_empty_node, removed_attachment_snapshot, resize_attachment, restore_attachment,
    restore_node_at, search_nodes_at, search_nodes_structured, soft_delete_node,
    sort_subtree_ascending, sort_subtree_descending, split_node_at, toggle_collapsed,
    toggle_complete, toggle_star, unarchive_node, update_node_at, validate_note_tag_filters,
    validate_structured_search_query_input, NewAttachment,
};
use crate::notes::types::{
    validate_note_id, ApplyBatchInput, CreateNodeInput, ImportAttachmentInput,
    ImportAttachmentPathBatchInput, MoveNodeInput, NoteAttachment, NoteSearchResult,
    NoteSearchScope, NoteStructuredSearchQuery,
    NoteTagSummary, NotesExportFormat, NotesExportResult, NotesExportSnapshot, NotesHistoryContext,
    NotesHistoryReplayResult, NotesHistoryStatus, NotesMutationResult, NotesWorkspace,
    NotesWorkspaceScope, ResizeAttachmentInput, SplitNodeInput, UpdateNodeInput,
};
use rusqlite::OptionalExtension;
use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

// Tests exercise the schema/migration pipeline directly through owned
// connections; production command bodies go through the connection manager.
#[cfg(test)]
use crate::notes::repository::connect_notes_db;

/// Runs a synchronous note operation on Tauri's blocking thread pool so the
/// per-command SQLite/file work never occupies the main (UI) thread. Each
/// `notes_*` command is a thin async wrapper over its `_inner` sync body; the
/// inner functions remain directly callable from tests.
///
/// The `_inner` bodies (and the repository/attachments/export/history helpers
/// they call) keep their `Result<_, String>` contracts; this wrapper is where
/// those messages are classified into a structured [`NotesError`] for the IPC
/// boundary (see [`NotesError::classify`]).
async fn run_blocking<T>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, NotesError>
where
    T: Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(operation).await {
        Ok(result) => result.map_err(NotesError::from),
        Err(join_error) => Err(NotesError::new(
            NotesErrorCode::Internal,
            format!("Notes background task failed: {join_error}"),
        )),
    }
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttachmentBatchFault {
    ReturnAfterPublished(usize),
    CrashAfterPublished(usize),
    CrashBeforeCommit,
}

#[cfg(test)]
thread_local! {
    static ATTACHMENT_BATCH_FAULT: std::cell::Cell<Option<AttachmentBatchFault>> = const { std::cell::Cell::new(None) };
    static ATTACHMENT_BATCH_CRASH_INTERRUPTED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
fn inject_attachment_batch_fault(fault: AttachmentBatchFault) {
    ATTACHMENT_BATCH_CRASH_INTERRUPTED.with(|interrupted| interrupted.set(false));
    ATTACHMENT_BATCH_FAULT.with(|current| current.set(Some(fault)));
}

fn maybe_inject_attachment_batch_after_publish(published_count: usize) -> Result<(), String> {
    #[cfg(not(test))]
    let _ = published_count;
    #[cfg(test)]
    {
        let fault = ATTACHMENT_BATCH_FAULT.with(std::cell::Cell::get);
        match fault {
            Some(AttachmentBatchFault::ReturnAfterPublished(expected))
                if expected == published_count =>
            {
                ATTACHMENT_BATCH_FAULT.with(|current| current.set(None));
                return Err("injected publication failure".to_string());
            }
            Some(AttachmentBatchFault::CrashAfterPublished(expected))
                if expected == published_count =>
            {
                ATTACHMENT_BATCH_FAULT.with(|current| current.set(None));
                ATTACHMENT_BATCH_CRASH_INTERRUPTED.with(|interrupted| interrupted.set(true));
                return Err(format!(
                    "injected attachment batch crash after published item {published_count}"
                ));
            }
            _ => {}
        }
    }
    Ok(())
}

fn maybe_inject_attachment_batch_before_commit() -> Result<(), String> {
    #[cfg(test)]
    if ATTACHMENT_BATCH_FAULT.with(std::cell::Cell::get)
        == Some(AttachmentBatchFault::CrashBeforeCommit)
    {
        ATTACHMENT_BATCH_FAULT.with(|current| current.set(None));
        ATTACHMENT_BATCH_CRASH_INTERRUPTED.with(|interrupted| interrupted.set(true));
        return Err("injected attachment batch crash before metadata commit".to_string());
    }
    Ok(())
}

fn take_attachment_batch_crash_interruption() -> bool {
    #[cfg(test)]
    {
        return ATTACHMENT_BATCH_CRASH_INTERRUPTED.with(|interrupted| {
            let value = interrupted.get();
            interrupted.set(false);
            value
        });
    }
    #[cfg(not(test))]
    false
}

#[cfg(test)]
thread_local! {
    /// When armed, `notes_delete_database_inner` acquires a connection in the
    /// window between evicting the cache and unlinking the files — simulating a
    /// read-only command (search, tag counts, …) that raced into that window and
    /// cached a handle to the inode deletion is about to unlink. The acquired
    /// connection is stashed so the test can assert the post-delete acquisition
    /// does not hand it back.
    static DELETE_DATABASE_RACE_ARMED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static DELETE_DATABASE_RACED_CONNECTION: std::cell::RefCell<
        Option<crate::notes::connection::SharedNotesConnection>,
    > = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn arm_delete_database_race() {
    DELETE_DATABASE_RACED_CONNECTION.with(|slot| *slot.borrow_mut() = None);
    DELETE_DATABASE_RACE_ARMED.with(|armed| armed.set(true));
}

#[cfg(test)]
fn take_delete_database_raced_connection(
) -> Option<crate::notes::connection::SharedNotesConnection> {
    DELETE_DATABASE_RACED_CONNECTION.with(|slot| slot.borrow_mut().take())
}

fn maybe_inject_delete_database_race(vault_path: &str) {
    #[cfg(not(test))]
    let _ = vault_path;
    #[cfg(test)]
    if DELETE_DATABASE_RACE_ARMED.with(|armed| {
        let value = armed.get();
        armed.set(false);
        value
    }) {
        // Reopen and cache the vault's connection the way a raced read command
        // would, then stash it so the test can verify the post-delete evict
        // drops it instead of leaving it bound to the unlinked inode.
        if let Ok(raced) = acquire_notes_connection(vault_path) {
            DELETE_DATABASE_RACED_CONNECTION.with(|slot| *slot.borrow_mut() = Some(raced));
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_initialize(vault_path: String) -> Result<(), NotesError> {
    run_blocking(move || notes_initialize_inner(vault_path)).await
}

pub(crate) fn notes_initialize_inner(vault_path: String) -> Result<(), String> {
    // Take the process-wide vault lock before anything else so a second window
    // is rejected up front (with a clear message) rather than after waiting on
    // the attachment lease. Holding it for the connection manager's lifetime is
    // what stops a second instance's `clear_all_history` below from destroying
    // this instance's undo history. Reentrant within one process.
    acquire_vault_app_lock(&vault_path)?;
    let storage = AttachmentStorageLease::acquire(&vault_path)?;
    // Opening a vault must run the schema/migration pipeline exactly once, so
    // force a fresh connection here even if an earlier command already cached
    // one. Every subsequent command reuses this connection without re-migrating.
    let shared = reinitialize_notes_connection(&vault_path)?;
    let mut connection = lock_notes_connection(&shared);
    clear_all_history(&mut connection)?;
    reconcile_after_committed_attachment_change(&storage, &connection);
    Ok(())
}

fn run_mutation(
    vault_path: &str,
    history_context: Option<NotesHistoryContext>,
    operation: impl FnOnce(&mut rusqlite::Connection) -> Result<NotesWorkspace, String>,
) -> Result<NotesMutationResult, String> {
    let storage = AttachmentStorageLease::acquire(vault_path)?;
    let shared = acquire_notes_connection(vault_path)?;
    let mut connection = lock_notes_connection(&shared);
    let result =
        with_history_transaction_and_prunes(&mut connection, history_context.as_ref(), operation)?;
    reconcile_candidates_after_committed_change(
        &storage,
        &connection,
        &result.pruned_attachment_paths,
    );
    Ok(result.into_mutation_result())
}

fn run_dated_mutation(
    vault_path: &str,
    history_context: Option<NotesHistoryContext>,
    today_provider: &impl LocalTodayProvider,
    operation: impl FnOnce(
        &mut rusqlite::Connection,
        crate::notes::date_index::LocalDate,
    ) -> Result<NotesWorkspace, String>,
) -> Result<NotesMutationResult, String> {
    let storage = AttachmentStorageLease::acquire(vault_path)?;
    let shared = acquire_notes_connection(vault_path)?;
    let mut connection = lock_notes_connection(&shared);
    let today = today_provider.local_today(&connection)?;
    let result = with_history_transaction_and_prunes(
        &mut connection,
        history_context.as_ref(),
        |connection| operation(connection, today),
    )?;
    reconcile_candidates_after_committed_change(
        &storage,
        &connection,
        &result.pruned_attachment_paths,
    );
    Ok(result.into_mutation_result())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_load_workspace(
    vault_path: String,
    scope: NotesWorkspaceScope,
) -> Result<NotesWorkspace, NotesError> {
    run_blocking(move || notes_load_workspace_inner(vault_path, scope)).await
}

pub(crate) fn notes_load_workspace_inner(
    vault_path: String,
    scope: NotesWorkspaceScope,
) -> Result<NotesWorkspace, String> {
    if let NotesWorkspaceScope::Tags { tags } = &scope {
        validate_note_tag_filters(tags)?;
    }
    let shared = acquire_notes_connection(&vault_path)?;
    let connection = lock_notes_connection(&shared);
    load_workspace(&connection, scope)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_create_node(
    vault_path: String,
    input: CreateNodeInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_create_node_inner(vault_path, input, history_context)).await
}

pub(crate) fn notes_create_node_inner(
    vault_path: String,
    input: CreateNodeInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_dated_mutation(
        &vault_path,
        history_context,
        &SystemLocalTodayProvider,
        |connection, today| create_node_at(connection, input, today),
    )
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_update_node(
    vault_path: String,
    input: UpdateNodeInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_update_node_inner(vault_path, input, history_context)).await
}

pub(crate) fn notes_update_node_inner(
    vault_path: String,
    input: UpdateNodeInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_dated_mutation(
        &vault_path,
        history_context,
        &SystemLocalTodayProvider,
        |connection, today| update_node_at(connection, input, today),
    )
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_split_node(
    vault_path: String,
    input: SplitNodeInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_split_node_inner(vault_path, input, history_context)).await
}

pub(crate) fn notes_split_node_inner(
    vault_path: String,
    input: SplitNodeInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_dated_mutation(
        &vault_path,
        history_context,
        &SystemLocalTodayProvider,
        |connection, today| split_node_at(connection, input, today),
    )
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_move_node(
    vault_path: String,
    input: MoveNodeInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_move_node_inner(vault_path, input, history_context)).await
}

pub(crate) fn notes_move_node_inner(
    vault_path: String,
    input: MoveNodeInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        move_node(connection, input)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_apply_batch(
    vault_path: String,
    input: ApplyBatchInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_apply_batch_inner(vault_path, input, history_context)).await
}

pub(crate) fn notes_apply_batch_inner(
    vault_path: String,
    input: ApplyBatchInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    // Batch ops are structural only (no title/note edits), so no date rebuild is
    // needed — a plain `run_mutation` gives us the single-transaction /
    // single-history-entry / delta behavior for free.
    run_mutation(&vault_path, history_context, |connection| {
        apply_batch(connection, input)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_toggle_complete(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_toggle_complete_inner(vault_path, node_id, history_context)).await
}

pub(crate) fn notes_toggle_complete_inner(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        toggle_complete(connection, &node_id)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_toggle_collapsed(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_toggle_collapsed_inner(vault_path, node_id, history_context)).await
}

pub(crate) fn notes_toggle_collapsed_inner(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        toggle_collapsed(connection, &node_id)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_collapse_all(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_collapse_all_inner(vault_path, node_id, history_context)).await
}

pub(crate) fn notes_collapse_all_inner(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        collapse_all(connection, &node_id)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_expand_all(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_expand_all_inner(vault_path, node_id, history_context)).await
}

pub(crate) fn notes_expand_all_inner(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        expand_all(connection, &node_id)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_sort_subtree_ascending(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_sort_subtree_ascending_inner(vault_path, node_id, history_context))
        .await
}

pub(crate) fn notes_sort_subtree_ascending_inner(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        sort_subtree_ascending(connection, &node_id)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_sort_subtree_descending(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_sort_subtree_descending_inner(vault_path, node_id, history_context))
        .await
}

pub(crate) fn notes_sort_subtree_descending_inner(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        sort_subtree_descending(connection, &node_id)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_toggle_star(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_toggle_star_inner(vault_path, node_id, history_context)).await
}

pub(crate) fn notes_toggle_star_inner(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        toggle_star(connection, &node_id)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_duplicate_node(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_duplicate_node_inner(vault_path, node_id, history_context)).await
}

pub(crate) fn notes_duplicate_node_inner(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_dated_mutation(
        &vault_path,
        history_context,
        &SystemLocalTodayProvider,
        |connection, today| duplicate_node_at(connection, &node_id, today),
    )
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_remove_empty_node(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_remove_empty_node_inner(vault_path, node_id, history_context)).await
}

pub(crate) fn notes_remove_empty_node_inner(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        remove_empty_node(connection, &node_id)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_soft_delete_node(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_soft_delete_node_inner(vault_path, node_id, history_context)).await
}

pub(crate) fn notes_soft_delete_node_inner(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        soft_delete_node(connection, &node_id)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_restore_node(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_restore_node_inner(vault_path, node_id, history_context)).await
}

pub(crate) fn notes_restore_node_inner(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_dated_mutation(
        &vault_path,
        history_context,
        &SystemLocalTodayProvider,
        |connection, today| restore_node_at(connection, &node_id, today),
    )
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_archive_node(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_archive_node_inner(vault_path, node_id, history_context)).await
}

pub(crate) fn notes_archive_node_inner(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        archive_node(connection, &node_id)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_unarchive_node(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_unarchive_node_inner(vault_path, node_id, history_context)).await
}

pub(crate) fn notes_unarchive_node_inner(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        unarchive_node(connection, &node_id)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_undo(
    vault_path: String,
    session_id: String,
    scope: NotesWorkspaceScope,
) -> Result<NotesHistoryReplayResult, NotesError> {
    run_blocking(move || notes_undo_inner(vault_path, session_id, scope)).await
}

pub(crate) fn notes_undo_inner(
    vault_path: String,
    session_id: String,
    scope: NotesWorkspaceScope,
) -> Result<NotesHistoryReplayResult, String> {
    notes_undo_with_provider(vault_path, session_id, scope, &SystemLocalTodayProvider)
}

fn notes_undo_with_provider(
    vault_path: String,
    session_id: String,
    scope: NotesWorkspaceScope,
    today_provider: &impl LocalTodayProvider,
) -> Result<NotesHistoryReplayResult, String> {
    let storage = AttachmentStorageLease::acquire(&vault_path)?;
    let shared = acquire_notes_connection(&vault_path)?;
    let mut connection = lock_notes_connection(&shared);
    let today = today_provider.local_today(&connection)?;
    let result =
        undo_with_attachment_storage_at(&mut connection, &session_id, scope, &storage, today)?;
    reconcile_after_committed_attachment_change(&storage, &connection);
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_redo(
    vault_path: String,
    session_id: String,
    scope: NotesWorkspaceScope,
) -> Result<NotesHistoryReplayResult, NotesError> {
    run_blocking(move || notes_redo_inner(vault_path, session_id, scope)).await
}

pub(crate) fn notes_redo_inner(
    vault_path: String,
    session_id: String,
    scope: NotesWorkspaceScope,
) -> Result<NotesHistoryReplayResult, String> {
    notes_redo_with_provider(vault_path, session_id, scope, &SystemLocalTodayProvider)
}

fn notes_redo_with_provider(
    vault_path: String,
    session_id: String,
    scope: NotesWorkspaceScope,
    today_provider: &impl LocalTodayProvider,
) -> Result<NotesHistoryReplayResult, String> {
    let storage = AttachmentStorageLease::acquire(&vault_path)?;
    let shared = acquire_notes_connection(&vault_path)?;
    let mut connection = lock_notes_connection(&shared);
    let today = today_provider.local_today(&connection)?;
    let result =
        redo_with_attachment_storage_at(&mut connection, &session_id, scope, &storage, today)?;
    reconcile_after_committed_attachment_change(&storage, &connection);
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_history_status(
    vault_path: String,
    session_id: String,
) -> Result<NotesHistoryStatus, NotesError> {
    run_blocking(move || notes_history_status_inner(vault_path, session_id)).await
}

pub(crate) fn notes_history_status_inner(
    vault_path: String,
    session_id: String,
) -> Result<NotesHistoryStatus, String> {
    let shared = acquire_notes_connection(&vault_path)?;
    let connection = lock_notes_connection(&shared);
    history_status(&connection, &session_id)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_clear_history(
    vault_path: String,
    session_id: String,
) -> Result<NotesHistoryStatus, NotesError> {
    run_blocking(move || notes_clear_history_inner(vault_path, session_id)).await
}

pub(crate) fn notes_clear_history_inner(
    vault_path: String,
    session_id: String,
) -> Result<NotesHistoryStatus, String> {
    let storage = AttachmentStorageLease::acquire(&vault_path)?;
    let shared = acquire_notes_connection(&vault_path)?;
    let mut connection = lock_notes_connection(&shared);
    let status = clear_history(&mut connection, &session_id)?;
    reconcile_after_committed_attachment_change(&storage, &connection);
    Ok(status)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_empty_trash(vault_path: String) -> Result<NotesWorkspace, NotesError> {
    run_blocking(move || notes_empty_trash_inner(vault_path)).await
}

pub(crate) fn notes_empty_trash_inner(vault_path: String) -> Result<NotesWorkspace, String> {
    let storage = AttachmentStorageLease::acquire(&vault_path)?;
    let shared = acquire_notes_connection(&vault_path)?;
    let mut connection = lock_notes_connection(&shared);
    let workspace = empty_trash(&mut connection)?;
    reconcile_after_committed_attachment_change(&storage, &connection);
    Ok(workspace)
}

fn attachment_metadata_error(
    storage: &AttachmentStorageLease,
    connection: &rusqlite::Connection,
    error: String,
) -> String {
    match storage.reconcile_attachment_files(connection) {
        Ok(_) => error,
        Err(reconcile_error) => {
            let _ = storage.mark_reconciliation_needed();
            format!("{error} Attachment reconciliation also failed: {reconcile_error}")
        }
    }
}

fn record_cleanup_warning(storage: &AttachmentStorageLease, error: String) {
    let marker_error = storage.mark_reconciliation_needed().err();
    match marker_error {
        Some(marker_error) => eprintln!(
            "Notes attachment cleanup warning: {error} Reconciliation marker also failed: {marker_error}"
        ),
        None => eprintln!("Notes attachment cleanup warning: {error}"),
    }
}

fn reconcile_after_committed_attachment_change(
    storage: &AttachmentStorageLease,
    connection: &rusqlite::Connection,
) {
    match storage.reconcile_attachment_files(connection) {
        Ok(_) => {
            if let Err(error) = storage.clear_reconciliation_marker() {
                eprintln!("Notes attachment cleanup warning: {error}");
            }
        }
        Err(error) => record_cleanup_warning(storage, error),
    }
}

fn reconcile_candidates_after_committed_change(
    storage: &AttachmentStorageLease,
    connection: &rusqlite::Connection,
    candidates: &[String],
) {
    if storage.reconciliation_needed().unwrap_or(true) {
        reconcile_after_committed_attachment_change(storage, connection);
        return;
    }
    if let Err(error) = storage.reconcile_attachment_candidates(connection, candidates) {
        record_cleanup_warning(storage, error);
    }
}

fn reconcile_before_attachment_batch(
    storage: &AttachmentStorageLease,
    connection: &rusqlite::Connection,
) -> Result<(), String> {
    if storage.reconciliation_needed()? {
        storage.reconcile_attachment_files(connection)?;
        storage.clear_reconciliation_marker()?;
    }
    Ok(())
}

fn reconcile_failed_attachment_batch(
    storage: &AttachmentStorageLease,
    connection: &rusqlite::Connection,
    candidates: &[String],
    error: String,
) -> String {
    let cleanup = storage
        .reconcile_attachment_candidates(connection, candidates)
        .and_then(|_| storage.clear_reconciliation_marker());
    match cleanup {
        Ok(()) => error,
        Err(cleanup_error) => {
            let _ = storage.mark_reconciliation_needed();
            format!("{error} Attachment reconciliation also failed: {cleanup_error}")
        }
    }
}

fn validate_attachment_batch_ids(node_id: &str, ids: &[String]) -> Result<(), String> {
    validate_note_id(node_id)?;
    let mut unique_ids = HashSet::with_capacity(ids.len());
    for id in ids {
        validate_note_id(id)
            .map_err(|_| "A Notes attachment ID must be a canonical UUID v4 string.".to_string())?;
        if !unique_ids.insert(id.as_str()) {
            return Err(format!(
                "A Notes attachment batch contains duplicate ID {id}."
            ));
        }
    }
    Ok(())
}

fn attachment_matches_prepared(existing: &NoteAttachment, expected: &NewAttachment) -> bool {
    existing.id == expected.id
        && existing.node_id == expected.node_id
        && existing.relative_path == expected.relative_path
        && existing.content_hash == expected.content_hash
        && existing.original_name == expected.original_name
        && existing.mime_type == expected.mime_type
        && existing.byte_size == expected.byte_size
        && existing.intrinsic_width == expected.intrinsic_width
        && existing.intrinsic_height == expected.intrinsic_height
        && existing.display_width == expected.display_width
}

fn inconsistent_attachment_batch() -> String {
    "The requested Notes attachment batch conflicts with inconsistent committed state.".to_string()
}

fn committed_attachment_batch_retry(
    connection: &rusqlite::Connection,
    expected: &[NewAttachment],
    history_context: Option<&NotesHistoryContext>,
) -> Result<Option<NotesMutationResult>, String> {
    let existing = expected
        .iter()
        .map(|attachment| attachment_by_id(connection, &attachment.id))
        .collect::<Result<Vec<_>, _>>()?;
    let existing_count = existing
        .iter()
        .filter(|attachment| attachment.is_some())
        .count();
    if existing_count == 0 {
        return Ok(None);
    }
    if existing_count != expected.len() {
        return Err(inconsistent_attachment_batch());
    }

    let existing = existing
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or_else(inconsistent_attachment_batch)?;
    let fields_match = existing
        .iter()
        .zip(expected)
        .all(|(actual, expected)| attachment_matches_prepared(actual, expected));
    let source_order_matches = existing
        .windows(2)
        .all(|pair| pair[0].sort_key < pair[1].sort_key);
    if !fields_match || !source_order_matches {
        return Err(inconsistent_attachment_batch());
    }

    let history_entry_id = if let Some(context) = history_context {
        let entry = connection
            .query_row(
                "SELECT session_id, command_kind, is_undone \
                 FROM notes_history_entries WHERE id = ?1",
                [&context.entry_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, bool>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("Could not inspect retry Notes history: {error}"))?;
        if entry.as_ref()
            != Some(&(
                context.session_id.clone(),
                context.command_kind.trim().to_string(),
                false,
            ))
        {
            return Err(inconsistent_attachment_batch());
        }

        let mut statement = connection
            .prepare(
                "SELECT table_name, row_id, before_json, after_json \
                 FROM notes_history_changes WHERE entry_id = ?1 ORDER BY ordinal",
            )
            .map_err(|error| format!("Could not prepare retry Notes history: {error}"))?;
        let changes = statement
            .query_map([&context.entry_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|error| format!("Could not read retry Notes history: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not collect retry Notes history: {error}"))?;
        if changes.len() != existing.len() {
            return Err(inconsistent_attachment_batch());
        }
        for ((table_name, row_id, before_json, after_json), actual) in
            changes.into_iter().zip(&existing)
        {
            let after = after_json
                .as_deref()
                .and_then(|json| serde_json::from_str::<NoteAttachment>(json).ok());
            if table_name != "notes_attachments"
                || row_id != actual.id
                || before_json.is_some()
                || after.as_ref() != Some(actual)
            {
                return Err(inconsistent_attachment_batch());
            }
        }
        Some(context.entry_id.clone())
    } else {
        for actual in &existing {
            let journaled: bool = connection
                .query_row(
                    "SELECT EXISTS(\
                       SELECT 1 FROM notes_history_changes \
                       WHERE table_name = 'notes_attachments' AND row_id = ?1\
                     )",
                    [&actual.id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not inspect retry Notes history: {error}"))?;
            if journaled {
                return Err(inconsistent_attachment_batch());
            }
        }
        None
    };

    let status = match history_context {
        Some(context) => history_status(connection, &context.session_id)?,
        None => NotesHistoryStatus::default(),
    };
    // This retry recognizes a batch a previous call already committed. To stay
    // idempotent with that original mutation it must report the same deltas.
    // The validation above proved the entry's only changes are these attachment
    // inserts (no node changes, nothing removed), so the delta is exactly the
    // committed attachments. Deltas are only exposed for the audited path; an
    // uncontexted original produced no audit rows and stays workspace-only.
    let deltas_available = history_context.is_some();
    Ok(Some(NotesMutationResult {
        workspace: load_workspace(connection, NotesWorkspaceScope::Active)?,
        history_entry_id,
        can_undo: status.can_undo,
        can_redo: status.can_redo,
        changed_nodes: deltas_available.then(Vec::new),
        removed_node_ids: deltas_available.then(Vec::new),
        changed_attachments: deltas_available.then(|| existing.clone()),
    }))
}

fn import_prepared_attachment_batch(
    node_id: String,
    ids: Vec<String>,
    initial_max_display_width: i64,
    history_context: Option<NotesHistoryContext>,
    prepared_batch: PreparedAttachmentBatch,
    storage: AttachmentStorageLease,
    connection: &mut rusqlite::Connection,
) -> Result<NotesMutationResult, String> {
    validate_attachment_batch_ids(&node_id, &ids)?;
    if initial_max_display_width <= 0 {
        return Err(
            "A Notes attachment initial maximum display width must be positive.".to_string(),
        );
    }
    if ids.len() != prepared_batch.attachments().len() {
        return Err("Notes attachment metadata does not match the prepared batch.".to_string());
    }

    let identity = storage.capture_database_identity(&*connection)?;
    let mut attachments = Vec::with_capacity(ids.len());
    for (id, prepared) in ids.into_iter().zip(prepared_batch.attachments()) {
        let byte_size = i64::try_from(prepared.image.byte_size)
            .map_err(|_| "The Notes attachment byte size is too large.".to_string())?;
        attachments.push(NewAttachment {
            id,
            node_id: node_id.clone(),
            relative_path: format!(
                "notes-assets/{}.{}",
                prepared.image.content_hash, prepared.image.extension
            ),
            content_hash: prepared.image.content_hash.clone(),
            original_name: prepared.original_name.clone(),
            mime_type: prepared.image.mime_type.to_string(),
            byte_size,
            intrinsic_width: i64::from(prepared.image.width),
            intrinsic_height: i64::from(prepared.image.height),
            display_width: initial_max_display_width.min(i64::from(prepared.image.width)),
        });
    }
    let candidates = attachments
        .iter()
        .map(|attachment| attachment.relative_path.clone())
        .collect::<Vec<_>>();

    if let Some(result) =
        committed_attachment_batch_retry(&*connection, &attachments, history_context.as_ref())?
    {
        return Ok(result);
    }

    storage.mark_reconciliation_needed()?;
    let result = with_history_transaction_and_prunes(
        &mut *connection,
        history_context.as_ref(),
        |connection| {
            create_attachments_coordinated_for_node(
                connection,
                &node_id,
                attachments,
                || {
                    for (index, (prepared, expected_path)) in prepared_batch
                        .attachments()
                        .iter()
                        .zip(&candidates)
                        .enumerate()
                    {
                        let published =
                            storage.publish_attachment_bytes_for_import(prepared, &identity)?;
                        if published != *expected_path {
                            return Err(
                                "Published Notes attachment path did not match its prepared metadata."
                                    .to_string(),
                            );
                        }
                        maybe_inject_attachment_batch_after_publish(index + 1)?;
                    }
                    Ok(())
                },
                || {
                    storage.validate_identity(&identity)?;
                    maybe_inject_attachment_batch_before_commit()
                },
            )
        },
    );

    match result {
        Ok(result) => {
            reconcile_after_committed_attachment_change(&storage, &*connection);
            Ok(result.into_mutation_result())
        }
        Err(error) => {
            if take_attachment_batch_crash_interruption() {
                Err(error)
            } else {
                Err(reconcile_failed_attachment_batch(
                    &storage,
                    &*connection,
                    &candidates,
                    error,
                ))
            }
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_import_attachment_paths_batch(
    vault_path: String,
    input: ImportAttachmentPathBatchInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || {
        notes_import_attachment_paths_batch_inner(vault_path, input, history_context)
    })
    .await
}

pub(crate) fn notes_import_attachment_paths_batch_inner(
    vault_path: String,
    input: ImportAttachmentPathBatchInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    let ids = input
        .attachments
        .iter()
        .map(|attachment| attachment.id.clone())
        .collect::<Vec<_>>();
    validate_attachment_batch_ids(&input.node_id, &ids)?;
    if input.initial_max_display_width <= 0 {
        return Err(
            "A Notes attachment initial maximum display width must be positive.".to_string(),
        );
    }
    let source_paths = input
        .attachments
        .iter()
        .map(|attachment| attachment.source_path.as_str())
        .collect::<Vec<_>>();
    let storage = AttachmentStorageLease::acquire(&vault_path)?;
    // Decode the sources and read their files BEFORE taking the connection lock.
    // The prepare step is pure file I/O with no database dependency, and holding
    // the per-vault `Mutex` across it would block every read on this vault (e.g.
    // search keystrokes) for the whole import — the exact cross-command blocking
    // task 1.2 aims to avoid ("hold the lock only around the DB work").
    let prepared_batch =
        PreparedAttachmentBatch::from_source_paths(&source_paths).map_err(|error| {
            let names = input
                .attachments
                .iter()
                .map(|attachment| attachment.source_path.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            format!("Could not prepare Notes attachment batch [{names}]: {error}")
        })?;
    let shared = acquire_notes_connection(&vault_path)?;
    let mut connection = lock_notes_connection(&shared);
    reconcile_before_attachment_batch(&storage, &connection)?;
    import_prepared_attachment_batch(
        input.node_id,
        ids,
        input.initial_max_display_width,
        history_context,
        prepared_batch,
        storage,
        &mut connection,
    )
}

fn notes_import_attachment_bytes_body(body: &[u8]) -> Result<NotesMutationResult, String> {
    let decoded = decode_raw_attachment_envelope(body)?;
    let ids = decoded
        .metadata
        .attachments
        .iter()
        .map(|attachment| attachment.id.clone())
        .collect::<Vec<_>>();
    validate_attachment_batch_ids(&decoded.metadata.node_id, &ids)?;
    let storage = AttachmentStorageLease::acquire(&decoded.metadata.vault_path)?;
    let shared = acquire_notes_connection(&decoded.metadata.vault_path)?;
    let mut connection = lock_notes_connection(&shared);
    reconcile_before_attachment_batch(&storage, &connection)?;
    let prepared_batch = PreparedAttachmentBatch::from_bytes(decoded.sources)?;
    import_prepared_attachment_batch(
        decoded.metadata.node_id,
        ids,
        decoded.metadata.initial_max_display_width,
        decoded.metadata.history_context,
        prepared_batch,
        storage,
        &mut connection,
    )
}

#[tauri::command]
pub(crate) async fn notes_import_attachment_bytes(
    request: tauri::ipc::Request<'_>,
) -> Result<NotesMutationResult, NotesError> {
    // `Request` borrows the IPC buffer, which is not `'static`, so copy the raw
    // body out before handing ownership to the blocking pool.
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(body) => body.to_vec(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(NotesError::new(
                NotesErrorCode::Internal,
                "Notes attachment byte imports require a raw IPC body.",
            ));
        }
    };
    run_blocking(move || notes_import_attachment_bytes_body(&body)).await
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_import_attachment(
    vault_path: String,
    input: ImportAttachmentInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_import_attachment_inner(vault_path, input, history_context)).await
}

pub(crate) fn notes_import_attachment_inner(
    vault_path: String,
    input: ImportAttachmentInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    notes_import_attachment_paths_batch_inner(
        vault_path,
        ImportAttachmentPathBatchInput {
            node_id: input.node_id,
            attachments: vec![crate::notes::types::ImportAttachmentPathItem {
                id: input.id,
                source_path: input.source_path,
            }],
            initial_max_display_width: input.initial_max_display_width,
        },
        history_context,
    )
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_read_attachment_bytes(
    vault_path: String,
    attachment_id: String,
) -> Result<tauri::ipc::Response, NotesError> {
    // Return the attachment as a raw IPC body so Tauri streams the bytes instead
    // of serializing a multi-megabyte image into a JSON number array (which the
    // webview would then re-parse element by element).
    let bytes =
        run_blocking(move || notes_read_attachment_bytes_inner(vault_path, attachment_id)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

pub(crate) fn notes_read_attachment_bytes_inner(
    vault_path: String,
    attachment_id: String,
) -> Result<Vec<u8>, String> {
    let storage = AttachmentStorageLease::acquire(&vault_path)?;
    let shared = acquire_notes_connection(&vault_path)?;
    // Hold the connection lock only for the metadata lookup; the (potentially
    // large) attachment file read and hash verification runs without it so
    // concurrent reads on the same vault do not serialize on the byte copy.
    let attachment = {
        let connection = lock_notes_connection(&shared);
        attachment_by_id(&connection, &attachment_id)?
            .ok_or_else(|| format!("Notes attachment {attachment_id} does not exist."))?
    };
    storage.read_validated_attachment_bytes(&attachment)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_resize_attachment(
    vault_path: String,
    input: ResizeAttachmentInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_resize_attachment_inner(vault_path, input, history_context)).await
}

pub(crate) fn notes_resize_attachment_inner(
    vault_path: String,
    input: ResizeAttachmentInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    let storage = AttachmentStorageLease::acquire(&vault_path)?;
    let shared = acquire_notes_connection(&vault_path)?;
    let mut connection = lock_notes_connection(&shared);
    let result = with_history_transaction_and_prunes(
        &mut connection,
        history_context.as_ref(),
        |connection| resize_attachment(connection, &input.id, input.display_width),
    )?;
    // Candidates-only, mirroring `run_mutation`: the pruned-path set is the
    // complete candidate list (a resize touches no attachment files at all), and
    // `reconcile_candidates_after_committed_change` still escalates to a full
    // reachable-set scan whenever the reconciliation marker is set. The extra
    // unconditional full pass was pure redundancy.
    reconcile_candidates_after_committed_change(
        &storage,
        &connection,
        &result.pruned_attachment_paths,
    );
    Ok(result.into_mutation_result())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_remove_attachment(
    vault_path: String,
    attachment_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_remove_attachment_inner(vault_path, attachment_id, history_context))
        .await
}

pub(crate) fn notes_remove_attachment_inner(
    vault_path: String,
    attachment_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    let storage = AttachmentStorageLease::acquire(&vault_path)?;
    let shared = acquire_notes_connection(&vault_path)?;
    let mut connection = lock_notes_connection(&shared);
    let result = with_history_transaction_and_prunes(
        &mut connection,
        history_context.as_ref(),
        |connection| remove_attachment(connection, &attachment_id),
    )?;
    // Candidates-only, mirroring `run_mutation`. A removed attachment's file
    // stays reachable through its history rows and is only pruned when that
    // history is trimmed, at which point the trimmed path is recorded in
    // `pruned_attachment_paths`; the candidates pass escalates to a full scan
    // whenever the reconciliation marker is set, so the former unconditional
    // full pass added nothing.
    reconcile_candidates_after_committed_change(
        &storage,
        &connection,
        &result.pruned_attachment_paths,
    );
    Ok(result.into_mutation_result())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_restore_attachment(
    vault_path: String,
    attachment_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || {
        notes_restore_attachment_inner(vault_path, attachment_id, history_context)
    })
    .await
}

pub(crate) fn notes_restore_attachment_inner(
    vault_path: String,
    attachment_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    let storage = AttachmentStorageLease::acquire(&vault_path)?;
    let shared = acquire_notes_connection(&vault_path)?;
    let mut connection = lock_notes_connection(&shared);
    let attachment = removed_attachment_snapshot(&connection, &attachment_id)?;
    storage.read_validated_attachment_bytes(&attachment)?;
    match with_history_transaction_and_prunes(
        &mut connection,
        history_context.as_ref(),
        |connection| restore_attachment(connection, attachment),
    ) {
        Ok(result) => {
            reconcile_after_committed_attachment_change(&storage, &connection);
            Ok(result.into_mutation_result())
        }
        Err(error) => Err(attachment_metadata_error(&storage, &connection, error)),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_search(
    vault_path: String,
    query: String,
    scope: NoteSearchScope,
) -> Result<Vec<NoteSearchResult>, NotesError> {
    run_blocking(move || notes_search_inner(vault_path, query, scope)).await
}

pub(crate) fn notes_search_inner(
    vault_path: String,
    query: String,
    scope: NoteSearchScope,
) -> Result<Vec<NoteSearchResult>, String> {
    notes_search_with_provider(vault_path, query, scope, &SystemLocalTodayProvider)
}

fn notes_search_with_provider(
    vault_path: String,
    query: String,
    scope: NoteSearchScope,
    today_provider: &impl LocalTodayProvider,
) -> Result<Vec<NoteSearchResult>, String> {
    let shared = acquire_notes_connection(&vault_path)?;
    let connection = lock_notes_connection(&shared);
    let today = today_provider.local_today(&connection)?;
    search_nodes_at(&connection, &query, scope, today)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_search_structured(
    vault_path: String,
    query: NoteStructuredSearchQuery,
) -> Result<Vec<NoteSearchResult>, NotesError> {
    run_blocking(move || notes_search_structured_inner(vault_path, query)).await
}

pub(crate) fn notes_search_structured_inner(
    vault_path: String,
    query: NoteStructuredSearchQuery,
) -> Result<Vec<NoteSearchResult>, String> {
    validate_structured_search_query_input(&query)?;
    let shared = acquire_notes_connection(&vault_path)?;
    let connection = lock_notes_connection(&shared);
    search_nodes_structured(&connection, &query)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_list_tags(vault_path: String) -> Result<Vec<String>, NotesError> {
    run_blocking(move || notes_list_tags_inner(vault_path)).await
}

pub(crate) fn notes_list_tags_inner(vault_path: String) -> Result<Vec<String>, String> {
    let shared = acquire_notes_connection(&vault_path)?;
    let connection = lock_notes_connection(&shared);
    list_tags(&connection)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_list_tags_with_counts(
    vault_path: String,
) -> Result<Vec<NoteTagSummary>, NotesError> {
    run_blocking(move || notes_list_tags_with_counts_inner(vault_path)).await
}

pub(crate) fn notes_list_tags_with_counts_inner(
    vault_path: String,
) -> Result<Vec<NoteTagSummary>, String> {
    let shared = acquire_notes_connection(&vault_path)?;
    let connection = lock_notes_connection(&shared);
    list_tags_with_counts(&connection)
}

#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteDatabaseOutcome {
    attachment_cleanup_failed: bool,
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_delete_database(
    vault_path: String,
) -> Result<DeleteDatabaseOutcome, NotesError> {
    run_blocking(move || notes_delete_database_inner(vault_path)).await
}

pub(crate) fn notes_delete_database_inner(
    vault_path: String,
) -> Result<DeleteDatabaseOutcome, String> {
    let storage = AttachmentStorageLease::acquire(&vault_path)?;
    // Close and forget the cached connection before removing the files so no
    // open handle survives the deletion and the next acquisition reconnects.
    evict_notes_connection(&vault_path);
    // Read-only commands (search, tag counts, …) take no attachment lease and
    // run outside the structural queue, so one can slip into the window between
    // the evict above and the file removal below, reopen the old file, and cache
    // a connection to the now-unlinked inode — leaving reads showing deleted
    // data and writes silently lost on restart. Evict again after deletion so
    // any such raced connection is dropped; a later reader then reconnects
    // against a fresh empty database, matching the pre-manager behavior.
    maybe_inject_delete_database_race(&vault_path);
    let deletion = delete_database(&vault_path);
    evict_notes_connection(&vault_path);
    deletion?;
    let attachment_cleanup_failed = match storage.delete_attachment_files() {
        Ok(()) => false,
        Err(error) => {
            eprintln!("Notes attachment cleanup warning: {error}");
            true
        }
    };
    Ok(DeleteDatabaseOutcome {
        attachment_cleanup_failed,
    })
}

fn export_destination_path(destination: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(destination);
    path.file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "File path must name a file.".to_string())?;
    Ok(path)
}

fn ensure_export_destination_is_available(path: &PathBuf) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(crate::file_io::DESTINATION_EXISTS_MESSAGE.to_string()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn ensure_export_destination_is_not_directory(path: &PathBuf) -> Result<(), String> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => Err("File path must name a file.".to_string()),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn export_snapshot_has_attachments(snapshot: &NotesExportSnapshot) -> bool {
    fn node_has_attachments(node: &crate::notes::types::ExportNode) -> bool {
        !node.attachments.is_empty() || node.children.iter().any(node_has_attachments)
    }

    node_has_attachments(&snapshot.root)
}

fn hydrate_export_snapshot_if_needed(
    vault_path: &str,
    connection: &rusqlite::Connection,
    root_node_id: &str,
    mut snapshot: NotesExportSnapshot,
) -> Result<NotesExportSnapshot, String> {
    if !export_snapshot_has_attachments(&snapshot) {
        return Ok(snapshot);
    }

    let storage = AttachmentStorageLease::acquire(vault_path)?;
    snapshot = load_export_snapshot(connection, root_node_id)?;
    hydrate_export_attachments(&mut snapshot, |attachment| {
        storage.read_validated_export_attachment_bytes(attachment)
    })?;
    Ok(snapshot)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_export_markdown(
    vault_path: String,
    root_node_id: String,
    destination: String,
    overwrite: bool,
) -> Result<NotesExportResult, NotesError> {
    run_blocking(move || {
        notes_export_markdown_inner(vault_path, root_node_id, destination, overwrite)
    })
    .await
}

pub(crate) fn notes_export_markdown_inner(
    vault_path: String,
    root_node_id: String,
    destination: String,
    overwrite: bool,
) -> Result<NotesExportResult, String> {
    validate_note_id(&root_node_id)?;
    let destination_path = export_destination_path(&destination)?;
    ensure_export_destination_is_not_directory(&destination_path)?;
    if !overwrite {
        ensure_export_destination_is_available(&destination_path)?;
    }

    let connection = open_notes_export_db(&vault_path)?;
    let snapshot = load_export_snapshot(&connection, &root_node_id)?;
    let markdown_assets = if export_snapshot_has_attachments(&snapshot) {
        let destination = markdown_asset_destination(&destination_path)?;
        preflight_markdown_asset_destination(&destination.0, overwrite)?;
        Some(destination)
    } else {
        None
    };
    let snapshot =
        hydrate_export_snapshot_if_needed(&vault_path, &connection, &root_node_id, snapshot)?;

    if export_snapshot_has_attachments(&snapshot) {
        let (asset_destination, asset_directory_name) = markdown_assets.ok_or_else(|| {
            "Notes export attachment destinations were not preflighted.".to_string()
        })?;
        let prepared = prepare_markdown_export(&snapshot, &asset_directory_name)?;
        publish_markdown_export(&destination_path, &asset_destination, &prepared, overwrite)?;
    } else {
        let bytes = render_markdown(&snapshot)?;
        write_atomic_file(&destination_path, &bytes, overwrite)?;
    }

    Ok(NotesExportResult {
        destination,
        format: NotesExportFormat::Markdown,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_export_pdf(
    vault_path: String,
    root_node_id: String,
    destination: String,
    overwrite: bool,
) -> Result<NotesExportResult, NotesError> {
    run_blocking(move || notes_export_pdf_inner(vault_path, root_node_id, destination, overwrite))
        .await
}

pub(crate) fn notes_export_pdf_inner(
    vault_path: String,
    root_node_id: String,
    destination: String,
    overwrite: bool,
) -> Result<NotesExportResult, String> {
    export_notes_file(
        vault_path,
        root_node_id,
        destination,
        overwrite,
        NotesExportFormat::Pdf,
        render_pdf,
    )
}

fn export_notes_file(
    vault_path: String,
    root_node_id: String,
    destination: String,
    overwrite: bool,
    format: NotesExportFormat,
    renderer: impl FnOnce(&NotesExportSnapshot) -> Result<Vec<u8>, String>,
) -> Result<NotesExportResult, String> {
    validate_note_id(&root_node_id)?;
    let destination_path = export_destination_path(&destination)?;
    ensure_export_destination_is_not_directory(&destination_path)?;
    if !overwrite {
        ensure_export_destination_is_available(&destination_path)?;
    }

    let connection = open_notes_export_db(&vault_path)?;
    let snapshot = load_export_snapshot(&connection, &root_node_id)?;
    let snapshot =
        hydrate_export_snapshot_if_needed(&vault_path, &connection, &root_node_id, snapshot)?;
    let bytes = renderer(&snapshot)?;
    write_atomic_file(&destination_path, &bytes, overwrite)?;

    Ok(NotesExportResult {
        destination,
        format,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    // The public `notes_*` commands are now async wrappers that dispatch onto the
    // blocking thread pool. These tests (and the thread-local fault injectors
    // above) must run the note logic inline on the test thread, so alias each
    // command name to its synchronous `_inner` body. Every existing call site
    // stays byte-for-byte identical.
    use super::{
        notes_apply_batch_inner as notes_apply_batch,
        notes_archive_node_inner as notes_archive_node,
        notes_collapse_all_inner as notes_collapse_all,
        notes_create_node_inner as notes_create_node,
        notes_delete_database_inner as notes_delete_database,
        notes_duplicate_node_inner as notes_duplicate_node,
        notes_empty_trash_inner as notes_empty_trash,
        notes_expand_all_inner as notes_expand_all,
        notes_export_markdown_inner as notes_export_markdown,
        notes_export_pdf_inner as notes_export_pdf,
        notes_history_status_inner as notes_history_status,
        notes_import_attachment_inner as notes_import_attachment,
        notes_import_attachment_paths_batch_inner as notes_import_attachment_paths_batch,
        notes_initialize_inner as notes_initialize,
        notes_list_tags_inner as notes_list_tags,
        notes_list_tags_with_counts_inner as notes_list_tags_with_counts,
        notes_load_workspace_inner as notes_load_workspace,
        notes_move_node_inner as notes_move_node,
        notes_redo_inner as notes_redo,
        notes_remove_attachment_inner as notes_remove_attachment,
        notes_remove_empty_node_inner as notes_remove_empty_node,
        notes_restore_node_inner as notes_restore_node,
        notes_search_inner as notes_search,
        notes_search_structured_inner as notes_search_structured,
        notes_soft_delete_node_inner as notes_soft_delete_node,
        notes_sort_subtree_ascending_inner as notes_sort_subtree_ascending,
        notes_sort_subtree_descending_inner as notes_sort_subtree_descending,
        notes_split_node_inner as notes_split_node,
        notes_toggle_collapsed_inner as notes_toggle_collapsed,
        notes_toggle_complete_inner as notes_toggle_complete,
        notes_toggle_star_inner as notes_toggle_star,
        notes_unarchive_node_inner as notes_unarchive_node,
        notes_undo_inner as notes_undo,
        notes_update_node_inner as notes_update_node,
    };
    use crate::notes::date_index::LocalDate;
    use crate::notes::types::{
        ApplyBatchInput, BatchOp, ImportAttachmentInput, ImportAttachmentPathBatchInput,
        ImportAttachmentPathItem, NoteLayoutMode, NoteNode, NoteSearchMatchedField,
        NoteSearchResult, NoteSearchTag, NoteStructuredSearchQuery, NoteTagFilter, NoteTagPrefix,
        NoteTagSummary, NotesExportFormat, MAX_NOTE_ATTACHMENTS_PER_NODE,
        MAX_NOTE_ATTACHMENTS_PER_VAULT,
    };
    use rusqlite::params;
    use serde_json::json;

    const ROOT_ID: &str = "11111111-1111-4111-8111-111111111111";
    const SPLIT_ID: &str = "22222222-2222-4222-8222-222222222222";
    const EMPTY_ID: &str = "33333333-3333-4333-8333-333333333333";
    const SESSION_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const REPLACEMENT_ENTRY_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const NOOP_ENTRY_ID: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const INVALID_DESCENDANT_ID: &str = "bad -->\n# injected";

    struct FixedLocalToday;

    impl LocalTodayProvider for FixedLocalToday {
        fn local_today(&self, _connection: &rusqlite::Connection) -> Result<LocalDate, String> {
            LocalDate::new(2026, 7, 11).ok_or_else(|| "invalid fixed today".to_string())
        }
    }

    fn assert_active(workspace: &NotesWorkspace) {
        assert!(workspace.nodes.iter().all(|node| node.deleted_at.is_none()));
    }

    const BATCH_A_ID: &str = "44444444-4444-4444-8444-444444444444";
    const BATCH_B_ID: &str = "55555555-5555-4555-8555-555555555555";
    const BATCH_C_ID: &str = "66666666-6666-4666-8666-666666666666";
    const BATCH_D_ID: &str = "77777777-7777-4777-8777-777777777777";
    const BATCH_MISSING_ID: &str = "99999999-9999-4999-8999-999999999999";

    fn seed_batch_node(vault_path: &str, id: &str, parent_id: Option<&str>, after_id: Option<&str>) {
        notes_create_node(
            vault_path.to_string(),
            CreateNodeInput {
                id: id.to_string(),
                parent_id: parent_id.map(str::to_string),
                after_id: after_id.map(str::to_string),
                title: id.to_string(),
                note: String::new(),
            },
            None,
        )
        .expect("seed batch node");
    }

    fn batch_op_context(entry_id: &str, command_kind: &str) -> NotesHistoryContext {
        NotesHistoryContext {
            session_id: SESSION_ID.to_string(),
            entry_id: entry_id.to_string(),
            command_kind: command_kind.to_string(),
        }
    }

    /// Live children of `parent_id` (NULL = roots) in document order.
    fn active_child_ids(vault_path: &str, parent_id: Option<&str>) -> Vec<String> {
        let connection = connect_notes_db(vault_path).expect("open vault for children");
        let mut statement = connection
            .prepare(
                "SELECT id, sort_key FROM notes_nodes \
                 WHERE parent_id IS ?1 AND deleted_at IS NULL AND archived_at IS NULL \
                 ORDER BY sort_key, id",
            )
            .expect("prepare active children");
        let rows = statement
            .query_map([parent_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .expect("query active children")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect active children");
        // Sort keys of live siblings must be strictly increasing and distinct.
        for pair in rows.windows(2) {
            assert!(
                pair[0].1 < pair[1].1,
                "sibling sort keys are not strictly increasing: {rows:?}"
            );
        }
        rows.into_iter().map(|(id, _)| id).collect()
    }

    fn deleted_batch_id_of(vault_path: &str, id: &str) -> Option<String> {
        let connection = connect_notes_db(vault_path).expect("open vault for batch id");
        connection
            .query_row(
                "SELECT deleted_batch_id FROM notes_nodes WHERE id = ?1",
                [id],
                |row| row.get::<_, Option<String>>(0),
            )
            .expect("read deleted batch id")
    }

    fn history_entry_count(vault_path: &str) -> i64 {
        let connection = connect_notes_db(vault_path).expect("open vault for history count");
        connection
            .query_row("SELECT COUNT(*) FROM notes_history_entries", [], |row| {
                row.get(0)
            })
            .expect("count history entries")
    }

    fn insert_limit_attachment_metadata(
        connection: &rusqlite::Connection,
        index: i64,
        node_id: &str,
    ) -> String {
        let id = format!("{index:08x}-dddd-4ddd-8ddd-{index:012x}");
        let content_hash = format!("{index:064x}");
        connection
            .execute(
                "INSERT INTO notes_attachments (\
                   id, node_id, sort_key, relative_path, content_hash, original_name, mime_type, \
                   byte_size, intrinsic_width, intrinsic_height, display_width, created_at, updated_at\
                 ) VALUES (\
                   ?1, ?2, ?3, ?4, ?5, 'seed.png', 'image/png', 1, 1, 1, 1, \
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
            .expect("insert attachment limit metadata");
        id
    }

    fn asset_directory_entries(vault_path: &str) -> Vec<String> {
        let directory = crate::metadata_dir(vault_path).join("notes-assets");
        if !directory.exists() {
            return Vec::new();
        }
        let mut entries = fs::read_dir(directory)
            .expect("read Notes asset directory")
            .map(|entry| {
                entry
                    .expect("read Notes asset entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<Vec<_>>();
        entries.sort();
        entries
    }

    fn seed_export_vault(vault_path: &str) {
        let connection = connect_notes_db(vault_path).expect("initialize export database");
        for (id, parent_id, sort_key, title, note, is_collapsed, completed_at, deleted_at) in [
            (
                ROOT_ID,
                None,
                1024,
                "Project",
                "Root note",
                true,
                None,
                None,
            ),
            (
                SPLIT_ID,
                Some(ROOT_ID),
                1024,
                "Completed child",
                "",
                true,
                Some("2026-07-10T01:00:00.000Z"),
                None,
            ),
            (
                EMPTY_ID,
                Some(SPLIT_ID),
                1024,
                "Visible below collapsed",
                "",
                false,
                None,
                None,
            ),
            (
                "44444444-4444-4444-8444-444444444444",
                Some(ROOT_ID),
                2048,
                "Deleted child",
                "",
                false,
                None,
                Some("2026-07-10T02:00:00.000Z"),
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO notes_nodes (\
                       id, parent_id, sort_key, title, note, is_collapsed, completed_at, \
                       created_at, updated_at, deleted_at\
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, \
                               '2026-07-10T00:00:00.000Z', \
                               '2026-07-10T00:00:00.000Z', ?8)",
                    rusqlite::params![
                        id,
                        parent_id,
                        sort_key,
                        title,
                        note,
                        is_collapsed,
                        completed_at,
                        deleted_at
                    ],
                )
                .expect("seed export node");
        }
    }

    fn encoded_png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, width, height);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().expect("PNG header");
            writer
                .write_image_data(&vec![0x55; width as usize * height as usize * 3])
                .expect("PNG pixels");
        }
        bytes
    }

    fn raw_attachment_envelope(
        vault_path: &str,
        attachments: &[(&str, &str, &str, &[u8])],
        history_context: Option<&NotesHistoryContext>,
    ) -> Vec<u8> {
        let history_context = history_context.map(|context| {
            json!({
                "sessionId": context.session_id,
                "entryId": context.entry_id,
                "commandKind": context.command_kind
            })
        });
        let metadata = json!({
            "vaultPath": vault_path,
            "nodeId": ROOT_ID,
            "attachments": attachments
                .iter()
                .enumerate()
                .map(|(ordinal, (id, original_name, mime_type, bytes))| json!({
                    "id": id,
                    "ordinal": ordinal,
                    "originalName": original_name,
                    "mimeType": mime_type,
                    "byteLength": bytes.len()
                }))
                .collect::<Vec<_>>(),
            "initialMaxDisplayWidth": 480,
            "historyContext": history_context
        });
        let metadata = serde_json::to_vec(&metadata).expect("encode raw metadata");
        let mut envelope = Vec::new();
        envelope.extend_from_slice(b"YNAB");
        envelope.push(1);
        envelope.extend_from_slice(
            &u32::try_from(metadata.len())
                .expect("raw metadata length")
                .to_le_bytes(),
        );
        envelope.extend_from_slice(&metadata);
        for (_, _, _, bytes) in attachments {
            envelope.extend_from_slice(bytes);
        }
        envelope
    }

    fn seed_attachment_batch_node(vault_path: &str) {
        notes_initialize(vault_path.to_string()).expect("initialize batch vault");
        notes_create_node(
            vault_path.to_string(),
            CreateNodeInput {
                id: ROOT_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "Root".to_string(),
                note: String::new(),
            },
            None,
        )
        .expect("create batch root");
    }

    fn path_batch_input(
        first_source: &PathBuf,
        second_source: &PathBuf,
    ) -> ImportAttachmentPathBatchInput {
        ImportAttachmentPathBatchInput {
            node_id: ROOT_ID.to_string(),
            attachments: vec![
                ImportAttachmentPathItem {
                    id: SPLIT_ID.to_string(),
                    source_path: first_source.to_string_lossy().into_owned(),
                },
                ImportAttachmentPathItem {
                    id: EMPTY_ID.to_string(),
                    source_path: second_source.to_string_lossy().into_owned(),
                },
            ],
            initial_max_display_width: 480,
        }
    }

    fn batch_history_context() -> NotesHistoryContext {
        NotesHistoryContext {
            session_id: SESSION_ID.to_string(),
            entry_id: REPLACEMENT_ENTRY_ID.to_string(),
            command_kind: "importAttachmentPaths".to_string(),
        }
    }

    fn import_export_attachment(
        temp_dir: &tempfile::TempDir,
        vault_path: &str,
        attachment_id: &str,
        source_name: &str,
    ) -> PathBuf {
        let source = temp_dir.path().join(source_name);
        fs::write(&source, encoded_png(4, 3)).expect("write attachment source");
        notes_import_attachment(
            vault_path.to_string(),
            ImportAttachmentInput {
                id: attachment_id.to_string(),
                node_id: ROOT_ID.to_string(),
                source_path: source.to_string_lossy().into_owned(),
                initial_max_display_width: 4,
            },
            None,
        )
        .expect("import export attachment");
        let connection = connect_notes_db(vault_path).expect("open attachment database");
        let relative_path: String = connection
            .query_row(
                "SELECT relative_path FROM notes_attachments WHERE id = ?1",
                [attachment_id],
                |row| row.get(0),
            )
            .expect("read owned attachment path");
        crate::metadata_dir(vault_path).join(relative_path)
    }

    #[test]
    fn notes_attachment_batch_paths_preserve_source_order_and_one_history_entry() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        notes_create_node(
            vault_path.clone(),
            CreateNodeInput {
                id: ROOT_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "Root".to_string(),
                note: String::new(),
            },
            None,
        )
        .expect("create root");
        let first_source = temp_dir.path().join("first.png");
        let second_source = temp_dir.path().join("second.png");
        fs::write(&first_source, encoded_png(4, 3)).expect("write first image");
        fs::write(&second_source, encoded_png(5, 4)).expect("write second image");
        let history_context = NotesHistoryContext {
            session_id: SESSION_ID.to_string(),
            entry_id: REPLACEMENT_ENTRY_ID.to_string(),
            command_kind: "importAttachmentPaths".to_string(),
        };

        let imported = notes_import_attachment_paths_batch(
            vault_path.clone(),
            ImportAttachmentPathBatchInput {
                node_id: ROOT_ID.to_string(),
                attachments: vec![
                    ImportAttachmentPathItem {
                        id: SPLIT_ID.to_string(),
                        source_path: first_source.to_string_lossy().into_owned(),
                    },
                    ImportAttachmentPathItem {
                        id: EMPTY_ID.to_string(),
                        source_path: second_source.to_string_lossy().into_owned(),
                    },
                ],
                initial_max_display_width: 480,
            },
            Some(history_context.clone()),
        )
        .expect("import path batch");

        let attachment_ids = imported.workspace.attachments_by_node_id[ROOT_ID]
            .iter()
            .map(|attachment| attachment.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(attachment_ids, vec![SPLIT_ID, EMPTY_ID]);
        assert_eq!(
            imported.history_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        let connection = connect_notes_db(&vault_path).expect("history database");
        let history_entries: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_history_entries WHERE id = ?1",
                [REPLACEMENT_ENTRY_ID],
                |row| row.get(0),
            )
            .expect("count history entries");
        assert_eq!(history_entries, 1);
        drop(connection);

        let undone = notes_undo(
            vault_path.clone(),
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("undo path batch");
        assert!(undone
            .workspace
            .attachments_by_node_id
            .get(ROOT_ID)
            .is_none_or(Vec::is_empty));
        let redone = notes_redo(
            vault_path,
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("redo path batch");
        assert_eq!(
            redone.workspace.attachments_by_node_id[ROOT_ID]
                .iter()
                .map(|attachment| attachment.id.as_str())
                .collect::<Vec<_>>(),
            vec![SPLIT_ID, EMPTY_ID]
        );
    }

    #[test]
    fn notes_attachment_batch_raw_preserves_order_and_rejects_malformed_bodies() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        notes_create_node(
            vault_path.clone(),
            CreateNodeInput {
                id: ROOT_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "Root".to_string(),
                note: String::new(),
            },
            None,
        )
        .expect("create root");
        let first = encoded_png(4, 3);
        let second = encoded_png(5, 4);
        let history_context = NotesHistoryContext {
            session_id: SESSION_ID.to_string(),
            entry_id: REPLACEMENT_ENTRY_ID.to_string(),
            command_kind: "importAttachmentBytes".to_string(),
        };
        let envelope = raw_attachment_envelope(
            &vault_path,
            &[
                (SPLIT_ID, "first.png", "image/png", &first),
                (EMPTY_ID, "second.png", "image/png", &second),
            ],
            Some(&history_context),
        );

        let imported = notes_import_attachment_bytes_body(&envelope).expect("import raw batch");
        assert_eq!(
            imported.workspace.attachments_by_node_id[ROOT_ID]
                .iter()
                .map(|attachment| attachment.id.as_str())
                .collect::<Vec<_>>(),
            vec![SPLIT_ID, EMPTY_ID]
        );
        assert_eq!(
            imported.history_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );

        let malformed =
            notes_import_attachment_bytes_body(b"bad").expect_err("malformed raw attachment body");
        assert!(malformed.contains("header is truncated"), "{malformed}");

        let oversized_metadata = json!({
            "vaultPath": vault_path,
            "nodeId": ROOT_ID,
            "attachments": (0..4).map(|ordinal| json!({
                "id": format!("90000000-0000-4000-8000-{ordinal:012x}"),
                "ordinal": ordinal,
                "originalName": format!("oversized-{ordinal}.png"),
                "mimeType": "image/png",
                "byteLength": 16 * 1024 * 1024 + 1
            })).collect::<Vec<_>>(),
            "initialMaxDisplayWidth": 480,
            "historyContext": null
        });
        let metadata = serde_json::to_vec(&oversized_metadata).expect("oversized metadata");
        let mut oversized = b"YNAB\x01".to_vec();
        oversized.extend_from_slice(
            &u32::try_from(metadata.len())
                .expect("oversized metadata length")
                .to_le_bytes(),
        );
        oversized.extend_from_slice(&metadata);
        let error =
            notes_import_attachment_bytes_body(&oversized).expect_err("aggregate raw batch limit");
        assert!(error.contains("67108864"), "{error}");
    }

    #[test]
    fn notes_attachment_batch_prevalidates_all_paths_and_cleans_publication_failures() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        seed_attachment_batch_node(&vault_path);
        let first_source = temp_dir.path().join("first.png");
        let invalid_source = temp_dir.path().join("invalid.txt");
        fs::write(&first_source, encoded_png(4, 3)).expect("write first image");
        fs::write(&invalid_source, b"not an image").expect("write invalid image");

        let error = notes_import_attachment_paths_batch(
            vault_path.clone(),
            path_batch_input(&first_source, &invalid_source),
            Some(batch_history_context()),
        )
        .expect_err("mixed invalid path batch");
        assert!(error.contains("invalid.txt"), "{error}");
        assert!(asset_directory_entries(&vault_path).is_empty());

        let second_source = temp_dir.path().join("second.png");
        fs::write(&second_source, encoded_png(5, 4)).expect("write second image");
        inject_attachment_batch_fault(AttachmentBatchFault::ReturnAfterPublished(1));
        let error = notes_import_attachment_paths_batch(
            vault_path.clone(),
            path_batch_input(&first_source, &second_source),
            Some(batch_history_context()),
        )
        .expect_err("injected publication failure");
        assert!(error.contains("injected publication failure"), "{error}");
        let connection = connect_notes_db(&vault_path).expect("inspect publication failure");
        let attachment_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("count attachment rows");
        let history_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_history_entries", [], |row| {
                row.get(0)
            })
            .expect("count history rows");
        assert_eq!((attachment_count, history_count), (0, 0));
        assert!(asset_directory_entries(&vault_path).is_empty());
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("inspect marker");
        assert!(!storage.reconciliation_needed().expect("marker state"));
    }

    #[test]
    fn notes_attachment_path_batch_reports_every_invalid_source_before_publish() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        seed_attachment_batch_node(&vault_path);
        let valid_source = temp_dir.path().join("valid.png");
        let empty_source = temp_dir.path().join("empty.png");
        let missing_source = temp_dir.path().join("missing.png");
        fs::write(&valid_source, encoded_png(4, 3)).expect("write valid image");
        fs::write(&empty_source, []).expect("write empty image");

        let error = notes_import_attachment_paths_batch(
            vault_path.clone(),
            ImportAttachmentPathBatchInput {
                node_id: ROOT_ID.to_string(),
                attachments: vec![
                    ImportAttachmentPathItem {
                        id: SPLIT_ID.to_string(),
                        source_path: valid_source.to_string_lossy().into_owned(),
                    },
                    ImportAttachmentPathItem {
                        id: EMPTY_ID.to_string(),
                        source_path: empty_source.to_string_lossy().into_owned(),
                    },
                    ImportAttachmentPathItem {
                        id: "44444444-4444-4444-8444-444444444444".to_string(),
                        source_path: missing_source.to_string_lossy().into_owned(),
                    },
                ],
                initial_max_display_width: 480,
            },
            Some(batch_history_context()),
        )
        .expect_err("invalid path batch");

        assert!(
            error.contains(
                "empty.png: Notes attachment images must contain between 1 and 20971520 bytes."
            ),
            "{error}"
        );
        assert!(
            error.contains("missing.png: Could not open the Notes attachment image:"),
            "{error}"
        );
        let connection = connect_notes_db(&vault_path).expect("inspect invalid path batch");
        let attachment_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("count attachment rows");
        assert_eq!(attachment_count, 0);
        assert!(asset_directory_entries(&vault_path).is_empty());
    }

    #[test]
    fn notes_attachment_batch_crash_marker_recovers_every_publication_boundary() {
        for fault in [
            AttachmentBatchFault::CrashAfterPublished(1),
            AttachmentBatchFault::CrashAfterPublished(2),
            AttachmentBatchFault::CrashBeforeCommit,
        ] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let vault_path = temp_dir.path().to_string_lossy().into_owned();
            seed_attachment_batch_node(&vault_path);
            let first_source = temp_dir.path().join("first.png");
            let second_source = temp_dir.path().join("second.png");
            fs::write(&first_source, encoded_png(4, 3)).expect("write first image");
            fs::write(&second_source, encoded_png(5, 4)).expect("write second image");
            inject_attachment_batch_fault(fault);

            let error = notes_import_attachment_paths_batch(
                vault_path.clone(),
                path_batch_input(&first_source, &second_source),
                Some(batch_history_context()),
            )
            .expect_err("injected crash");
            assert!(error.contains("injected attachment batch crash"), "{error}");
            let storage = AttachmentStorageLease::acquire(&vault_path).expect("crash marker");
            assert!(storage.reconciliation_needed().expect("marker state"));
            drop(storage);
            let connection = connect_notes_db(&vault_path).expect("crash database");
            let attachment_count: i64 = connection
                .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                    row.get(0)
                })
                .expect("count rolled back attachments");
            assert_eq!(attachment_count, 0);
            drop(connection);

            notes_initialize(vault_path.clone()).expect("restart reconciliation");
            assert!(asset_directory_entries(&vault_path).is_empty());
            let storage = AttachmentStorageLease::acquire(&vault_path).expect("cleared marker");
            assert!(!storage.reconciliation_needed().expect("marker state"));
        }
    }

    #[test]
    fn notes_initialize_reopens_the_same_vault_within_one_process() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();

        // The vault lock is reentrant within one process: opening, then reopening
        // the same vault (as a webview reload or a repeated command would) must
        // reuse the already-held lock instead of deadlocking against it.
        notes_initialize(vault_path.clone()).expect("first initialize");
        notes_initialize(vault_path.clone()).expect("reinitialize in the same process");
        notes_initialize(vault_path).expect("reinitialize again");
    }

    #[test]
    fn notes_initialize_rejects_a_second_instance_holding_the_vault_lock() {
        use fs4::FileExt;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();

        // Simulate another OS-level app instance holding the vault: open the lock
        // file directly and take the exclusive flock. A fresh descriptor from
        // this same process contends with that lock exactly as a second process
        // would, so `notes_initialize` (which has never cached a handle for this
        // vault) must be refused with the single-writer message rather than
        // running `clear_all_history` and wiping the other instance's undo stack.
        let metadata = crate::metadata_dir(&vault_path);
        fs::create_dir_all(&metadata).expect("create metadata directory");
        let lock_path = metadata.join("notes.app.lock");
        let foreign = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&lock_path)
            .expect("open the vault lock as another instance");
        FileExt::try_lock(&foreign).expect("another instance takes the vault lock");

        let error =
            notes_initialize(vault_path.clone()).expect_err("a second instance must be rejected");
        assert_eq!(error, "Notes vault is already open in another window.");

        // Once the other instance closes (releases the lock), this instance can
        // open the vault normally.
        FileExt::unlock(&foreign).expect("the other instance releases the vault lock");
        notes_initialize(vault_path).expect("initialize after the other instance closes");
    }

    #[test]
    fn notes_attachment_batch_failure_preserves_a_preexisting_shared_hash() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        seed_attachment_batch_node(&vault_path);
        let shared_source = temp_dir.path().join("shared.png");
        let unique_source = temp_dir.path().join("unique.png");
        fs::write(&shared_source, encoded_png(4, 3)).expect("write shared image");
        fs::write(&unique_source, encoded_png(5, 4)).expect("write unique image");
        notes_import_attachment(
            vault_path.clone(),
            ImportAttachmentInput {
                id: NOOP_ENTRY_ID.to_string(),
                node_id: ROOT_ID.to_string(),
                source_path: shared_source.to_string_lossy().into_owned(),
                initial_max_display_width: 480,
            },
            None,
        )
        .expect("seed shared attachment");
        let shared_entries = asset_directory_entries(&vault_path);
        assert_eq!(shared_entries.len(), 1);

        inject_attachment_batch_fault(AttachmentBatchFault::ReturnAfterPublished(2));
        notes_import_attachment_paths_batch(
            vault_path.clone(),
            path_batch_input(&shared_source, &unique_source),
            Some(batch_history_context()),
        )
        .expect_err("batch failure after shared publication");

        assert_eq!(asset_directory_entries(&vault_path), shared_entries);
        let connection = connect_notes_db(&vault_path).expect("shared database");
        let attachment_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("count shared attachment rows");
        assert_eq!(attachment_count, 1);
    }

    #[test]
    fn notes_attachment_batch_retry_is_idempotent_and_rejects_inconsistent_duplicates() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        seed_attachment_batch_node(&vault_path);
        let first_source = temp_dir.path().join("first.png");
        let second_source = temp_dir.path().join("second.png");
        fs::write(&first_source, encoded_png(4, 3)).expect("write first image");
        fs::write(&second_source, encoded_png(5, 4)).expect("write second image");
        let input = path_batch_input(&first_source, &second_source);
        let history_context = batch_history_context();

        let committed = notes_import_attachment_paths_batch(
            vault_path.clone(),
            input.clone(),
            Some(history_context.clone()),
        )
        .expect("commit batch before response loss");
        let retried = notes_import_attachment_paths_batch(
            vault_path.clone(),
            input.clone(),
            Some(history_context.clone()),
        )
        .expect("retry committed batch");
        assert_eq!(retried, committed);
        let connection = connect_notes_db(&vault_path).expect("retry database");
        let counts: (i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM notes_attachments), \
                        (SELECT COUNT(*) FROM notes_history_entries)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("retry counts");
        assert_eq!(counts, (2, 1));
        drop(connection);

        let mut reversed = input.clone();
        reversed.attachments.reverse();
        let error = notes_import_attachment_paths_batch(
            vault_path.clone(),
            reversed,
            Some(history_context.clone()),
        )
        .expect_err("mismatched duplicate source order");
        assert!(error.contains("inconsistent"), "{error}");

        let mismatched_source = temp_dir.path().join("mismatched.png");
        fs::write(&mismatched_source, encoded_png(6, 5)).expect("write mismatched image");
        let mut mismatched = input.clone();
        mismatched.attachments[1].source_path = mismatched_source.to_string_lossy().into_owned();
        let error = notes_import_attachment_paths_batch(
            vault_path.clone(),
            mismatched,
            Some(history_context.clone()),
        )
        .expect_err("mismatched duplicate content");
        assert!(error.contains("inconsistent"), "{error}");

        let mut mismatched_history = history_context;
        mismatched_history.command_kind = "differentCommand".to_string();
        let error =
            notes_import_attachment_paths_batch(vault_path, input, Some(mismatched_history))
                .expect_err("mismatched duplicate history");
        assert!(error.contains("inconsistent"), "{error}");
    }

    #[test]
    fn notes_attachment_batch_rejects_a_partial_duplicate_set() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        seed_attachment_batch_node(&vault_path);
        let first_source = temp_dir.path().join("first.png");
        let second_source = temp_dir.path().join("second.png");
        fs::write(&first_source, encoded_png(4, 3)).expect("write first image");
        fs::write(&second_source, encoded_png(5, 4)).expect("write second image");
        notes_import_attachment(
            vault_path.clone(),
            ImportAttachmentInput {
                id: SPLIT_ID.to_string(),
                node_id: ROOT_ID.to_string(),
                source_path: first_source.to_string_lossy().into_owned(),
                initial_max_display_width: 480,
            },
            None,
        )
        .expect("seed partial duplicate");

        let error = notes_import_attachment_paths_batch(
            vault_path.clone(),
            path_batch_input(&first_source, &second_source),
            Some(batch_history_context()),
        )
        .expect_err("partial duplicate batch");
        assert!(error.contains("inconsistent"), "{error}");
        assert_eq!(asset_directory_entries(&vault_path).len(), 1);
    }

    #[test]
    fn notes_dtos_use_the_typed_camel_case_wire_contract() {
        let create: CreateNodeInput = serde_json::from_value(json!({
            "id": ROOT_ID,
            "parentId": null,
            "afterId": null,
            "title": "Page",
            "note": "Supporting note"
        }))
        .expect("camelCase create input");
        assert_eq!(create.parent_id, None);
        assert_eq!(create.after_id, None);

        let move_before: MoveNodeInput = serde_json::from_value(json!({
            "id": ROOT_ID,
            "parentId": null,
            "afterId": null,
            "beforeId": SPLIT_ID
        }))
        .expect("camelCase move input with beforeId");
        assert_eq!(move_before.after_id, None);
        assert_eq!(move_before.before_id.as_deref(), Some(SPLIT_ID));

        let legacy_move: MoveNodeInput = serde_json::from_value(json!({
            "id": ROOT_ID,
            "parentId": null,
            "afterId": SPLIT_ID
        }))
        .expect("legacy move input with only afterId");
        assert_eq!(legacy_move.after_id.as_deref(), Some(SPLIT_ID));
        assert_eq!(legacy_move.before_id, None);

        let split: SplitNodeInput = serde_json::from_value(json!({
            "id": ROOT_ID,
            "newNodeId": SPLIT_ID,
            "prefix": "First",
            "suffix": "Second"
        }))
        .expect("camelCase split input");
        assert_eq!(split.new_node_id, SPLIT_ID);

        let scope: NotesWorkspaceScope =
            serde_json::from_value(json!({ "kind": "trash" })).expect("trash scope");
        assert_eq!(scope, NotesWorkspaceScope::Trash);
        let tag_scope: NotesWorkspaceScope =
            serde_json::from_value(json!({ "kind": "tag", "tag": "roadmap" })).expect("tag scope");
        assert_eq!(
            tag_scope,
            NotesWorkspaceScope::Tag {
                tag: "roadmap".to_string()
            }
        );

        let search_result = NoteSearchResult {
            node_id: ROOT_ID.to_string(),
            title: "Page".to_string(),
            parent_trail: vec!["Home".to_string()],
            matched_field: NoteSearchMatchedField::Title,
        };
        assert_eq!(
            serde_json::to_value(search_result).expect("search result JSON"),
            json!({
                "nodeId": ROOT_ID,
                "title": "Page",
                "parentTrail": ["Home"],
                "matchedField": "title"
            })
        );

        let workspace = NotesWorkspace {
            nodes: vec![NoteNode {
                id: ROOT_ID.to_string(),
                parent_id: None,
                sort_key: 1024,
                title: "Page".to_string(),
                note: "Supporting note".to_string(),
                layout_mode: NoteLayoutMode::Bullets,
                is_collapsed: false,
                is_starred: false,
                completed_at: None,
                created_at: "2026-07-10T00:00:00.000Z".to_string(),
                updated_at: "2026-07-10T00:00:00.000Z".to_string(),
                deleted_at: None,
                archived_at: None,
                archive_root_id: None,
            }],
            attachments_by_node_id: std::collections::BTreeMap::new(),
        };
        assert_eq!(
            serde_json::to_value(workspace).expect("workspace JSON"),
            json!({
                "nodes": [{
                    "id": ROOT_ID,
                    "parentId": null,
                    "sortKey": 1024,
                    "title": "Page",
                    "note": "Supporting note",
                    "layoutMode": "bullets",
                    "isCollapsed": false,
                    "isStarred": false,
                    "completedAt": null,
                    "createdAt": "2026-07-10T00:00:00.000Z",
                    "updatedAt": "2026-07-10T00:00:00.000Z",
                    "deletedAt": null,
                    "archivedAt": null,
                    "archiveRootId": null
                }],
                "attachmentsByNodeId": {}
            })
        );
    }

    #[test]
    fn commands_return_authoritative_active_workspaces_after_mutations() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();

        notes_initialize(vault_path.clone()).expect("initialize");
        assert!(
            notes_load_workspace(vault_path.clone(), NotesWorkspaceScope::Active)
                .expect("initial active workspace")
                .nodes
                .is_empty()
        );

        let workspace = notes_create_node(
            vault_path.clone(),
            CreateNodeInput {
                id: ROOT_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "Page".to_string(),
                note: String::new(),
            },
            None,
        )
        .expect("create");
        assert_active(&workspace.workspace);

        let workspace = notes_update_node(
            vault_path.clone(),
            UpdateNodeInput {
                id: ROOT_ID.to_string(),
                title: "Updated page".to_string(),
                note: "Context".to_string(),
            },
            None,
        )
        .expect("update");
        assert_eq!(workspace.workspace.nodes[0].title, "Updated page");

        let workspace = notes_split_node(
            vault_path.clone(),
            SplitNodeInput {
                id: ROOT_ID.to_string(),
                new_node_id: SPLIT_ID.to_string(),
                prefix: "First".to_string(),
                suffix: "Second".to_string(),
            },
            None,
        )
        .expect("split");
        assert_active(&workspace.workspace);

        notes_create_node(
            vault_path.clone(),
            CreateNodeInput {
                id: EMPTY_ID.to_string(),
                parent_id: Some(ROOT_ID.to_string()),
                after_id: None,
                title: String::new(),
                note: String::new(),
            },
            None,
        )
        .expect("create empty child");

        let workspace = notes_move_node(
            vault_path.clone(),
            MoveNodeInput {
                id: SPLIT_ID.to_string(),
                parent_id: Some(ROOT_ID.to_string()),
                after_id: Some(EMPTY_ID.to_string()),
                before_id: None,
            },
            None,
        )
        .expect("move");
        assert_active(&workspace.workspace);

        let workspace = notes_toggle_complete(vault_path.clone(), ROOT_ID.to_string(), None)
            .expect("toggle complete");
        assert!(workspace
            .workspace
            .nodes
            .iter()
            .find(|node| node.id == ROOT_ID)
            .unwrap()
            .completed_at
            .is_some());

        let workspace = notes_toggle_collapsed(vault_path.clone(), ROOT_ID.to_string(), None)
            .expect("toggle collapsed");
        assert!(
            workspace
                .workspace
                .nodes
                .iter()
                .find(|node| node.id == ROOT_ID)
                .unwrap()
                .is_collapsed
        );

        let workspace =
            notes_duplicate_node(vault_path.clone(), ROOT_ID.to_string(), None).expect("duplicate");
        assert_eq!(workspace.workspace.nodes.len(), 6);
        assert_active(&workspace.workspace);

        let workspace = notes_remove_empty_node(vault_path.clone(), EMPTY_ID.to_string(), None)
            .expect("remove empty");
        assert_eq!(workspace.workspace.nodes.len(), 5);
        assert_active(&workspace.workspace);

        let workspace = notes_soft_delete_node(vault_path.clone(), SPLIT_ID.to_string(), None)
            .expect("soft delete");
        assert_eq!(workspace.workspace.nodes.len(), 4);
        assert_active(&workspace.workspace);
        assert_eq!(
            notes_load_workspace(vault_path.clone(), NotesWorkspaceScope::Trash)
                .expect("trash workspace")
                .nodes
                .len(),
            2
        );

        let workspace =
            notes_restore_node(vault_path.clone(), SPLIT_ID.to_string(), None).expect("restore");
        assert_eq!(workspace.workspace.nodes.len(), 5);
        assert_active(&workspace.workspace);

        notes_soft_delete_node(vault_path.clone(), SPLIT_ID.to_string(), None)
            .expect("soft delete again");
        let workspace = notes_empty_trash(vault_path.clone()).expect("empty trash");
        assert_eq!(workspace.nodes.len(), 4);
        assert_active(&workspace);
        assert!(notes_load_workspace(vault_path, NotesWorkspaceScope::Trash)
            .expect("empty trash workspace")
            .nodes
            .is_empty());
    }

    #[test]
    fn mutation_commands_return_the_committed_history_result_atomically() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();

        notes_initialize(vault_path.clone()).expect("initialize");
        let created = notes_create_node(
            vault_path.clone(),
            CreateNodeInput {
                id: ROOT_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "Page".to_string(),
                note: String::new(),
            },
            Some(NotesHistoryContext {
                session_id: SESSION_ID.to_string(),
                entry_id: SPLIT_ID.to_string(),
                command_kind: "create".to_string(),
            }),
        )
        .expect("journaled create");
        assert_eq!(created.history_entry_id.as_deref(), Some(SPLIT_ID));
        assert!(created.can_undo);
        assert!(!created.can_redo);
        assert_eq!(created.workspace.nodes.len(), 1);

        let undone = notes_undo(
            vault_path.clone(),
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("undo create");
        assert!(undone.workspace.nodes.is_empty());
        assert!(undone.can_redo);

        let replacement = notes_create_node(
            vault_path.clone(),
            CreateNodeInput {
                id: EMPTY_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "Replacement".to_string(),
                note: String::new(),
            },
            Some(NotesHistoryContext {
                session_id: SESSION_ID.to_string(),
                entry_id: REPLACEMENT_ENTRY_ID.to_string(),
                command_kind: "create".to_string(),
            }),
        )
        .expect("replacement create");
        assert_eq!(
            replacement.history_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        assert!(replacement.can_undo);
        assert!(
            !replacement.can_redo,
            "new mutation invalidates redo atomically"
        );

        let unjournaled = notes_toggle_star(vault_path, EMPTY_ID.to_string(), None)
            .expect("unjournaled mutation");
        assert_eq!(unjournaled.history_entry_id, None);
        assert!(!unjournaled.can_undo);
        assert!(!unjournaled.can_redo);
        assert!(unjournaled.workspace.nodes[0].is_starred);
    }

    #[test]
    fn collapse_all_is_one_atomic_history_entry_with_undo_and_redo() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        for (id, parent_id) in [
            (ROOT_ID, None),
            (SPLIT_ID, Some(ROOT_ID)),
            (EMPTY_ID, Some(SPLIT_ID)),
        ] {
            notes_create_node(
                vault_path.clone(),
                CreateNodeInput {
                    id: id.to_string(),
                    parent_id: parent_id.map(str::to_string),
                    after_id: None,
                    title: id.to_string(),
                    note: String::new(),
                },
                None,
            )
            .expect("seed subtree node");
        }

        let mutation = notes_collapse_all(
            vault_path.clone(),
            ROOT_ID.to_string(),
            Some(NotesHistoryContext {
                session_id: SESSION_ID.to_string(),
                entry_id: REPLACEMENT_ENTRY_ID.to_string(),
                command_kind: "collapseAll".to_string(),
            }),
        )
        .expect("collapse subtree");

        assert_eq!(
            mutation.history_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        assert!(mutation.can_undo);
        assert!(!mutation.can_redo);
        assert_eq!(
            mutation
                .workspace
                .nodes
                .iter()
                .filter(|node| node.is_collapsed)
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![ROOT_ID, SPLIT_ID]
        );

        let undone = notes_undo(
            vault_path.clone(),
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("undo collapse subtree");
        assert_eq!(
            undone.replayed_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        assert!(undone.workspace.nodes.iter().all(|node| !node.is_collapsed));

        let redone = notes_redo(
            vault_path,
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("redo collapse subtree");
        assert_eq!(
            redone.replayed_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        assert_eq!(
            redone
                .workspace
                .nodes
                .iter()
                .filter(|node| node.is_collapsed)
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![ROOT_ID, SPLIT_ID]
        );
    }

    #[test]
    fn batch_complete_sets_every_node_in_one_history_entry_and_undo_reverts_all() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        for id in [BATCH_A_ID, BATCH_B_ID, BATCH_C_ID] {
            seed_batch_node(&vault_path, id, None, None);
        }

        let mutation = notes_apply_batch(
            vault_path.clone(),
            ApplyBatchInput {
                node_ids: vec![
                    BATCH_A_ID.to_string(),
                    BATCH_B_ID.to_string(),
                    BATCH_C_ID.to_string(),
                ],
                op: BatchOp::Complete { completed: true },
            },
            Some(batch_op_context(REPLACEMENT_ENTRY_ID, "batchComplete")),
        )
        .expect("batch complete");

        assert_eq!(
            mutation.history_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        assert!(mutation.can_undo);
        assert!(mutation
            .workspace
            .nodes
            .iter()
            .all(|node| node.completed_at.is_some()));
        // Exactly one history entry covers the whole batch.
        assert_eq!(history_entry_count(&vault_path), 1);
        // The delta enumerates every touched node (Phase 1.5 wiring).
        let mut changed = mutation
            .changed_nodes
            .as_ref()
            .expect("batch mutation carries a node delta")
            .iter()
            .map(|node| node.id.clone())
            .collect::<Vec<_>>();
        changed.sort();
        assert_eq!(
            changed,
            vec![
                BATCH_A_ID.to_string(),
                BATCH_B_ID.to_string(),
                BATCH_C_ID.to_string()
            ]
        );

        let undone = notes_undo(
            vault_path.clone(),
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("undo batch complete");
        assert_eq!(
            undone.replayed_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        assert!(undone
            .workspace
            .nodes
            .iter()
            .all(|node| node.completed_at.is_none()));
    }

    #[test]
    fn batch_delete_shares_one_trash_batch_and_undo_restores_all() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        // Two independent subtrees: A>A_child and B>B_child.
        seed_batch_node(&vault_path, BATCH_A_ID, None, None);
        seed_batch_node(&vault_path, BATCH_C_ID, Some(BATCH_A_ID), None);
        seed_batch_node(&vault_path, BATCH_B_ID, None, Some(BATCH_A_ID));
        seed_batch_node(&vault_path, BATCH_D_ID, Some(BATCH_B_ID), None);

        let mutation = notes_apply_batch(
            vault_path.clone(),
            ApplyBatchInput {
                node_ids: vec![BATCH_A_ID.to_string(), BATCH_B_ID.to_string()],
                op: BatchOp::Delete,
            },
            Some(batch_op_context(REPLACEMENT_ENTRY_ID, "batchDelete")),
        )
        .expect("batch delete");

        assert_eq!(
            mutation.history_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        assert!(mutation.workspace.nodes.is_empty());
        assert_eq!(history_entry_count(&vault_path), 1);

        // All four deleted rows share one non-null deletion batch id.
        let batch_id = deleted_batch_id_of(&vault_path, BATCH_A_ID).expect("A deletion batch");
        for id in [BATCH_A_ID, BATCH_C_ID, BATCH_B_ID, BATCH_D_ID] {
            assert_eq!(
                deleted_batch_id_of(&vault_path, id).as_deref(),
                Some(batch_id.as_str()),
                "node {id} does not share the batch deletion id"
            );
        }

        let undone = notes_undo(
            vault_path.clone(),
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("undo batch delete");
        let mut restored = undone
            .workspace
            .nodes
            .iter()
            .map(|node| node.id.clone())
            .collect::<Vec<_>>();
        restored.sort();
        assert_eq!(
            restored,
            vec![
                BATCH_A_ID.to_string(),
                BATCH_B_ID.to_string(),
                BATCH_C_ID.to_string(),
                BATCH_D_ID.to_string()
            ]
        );
    }

    #[test]
    fn batch_delete_restore_is_scoped_to_the_restored_subtree() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        seed_batch_node(&vault_path, BATCH_A_ID, None, None);
        seed_batch_node(&vault_path, BATCH_C_ID, Some(BATCH_A_ID), None);
        seed_batch_node(&vault_path, BATCH_B_ID, None, Some(BATCH_A_ID));
        seed_batch_node(&vault_path, BATCH_D_ID, Some(BATCH_B_ID), None);

        notes_apply_batch(
            vault_path.clone(),
            ApplyBatchInput {
                node_ids: vec![BATCH_A_ID.to_string(), BATCH_B_ID.to_string()],
                op: BatchOp::Delete,
            },
            Some(batch_op_context(REPLACEMENT_ENTRY_ID, "batchDelete")),
        )
        .expect("batch delete");

        // Restoring one batch member restores only its subtree; the sibling
        // subtree stays trashed even though it shares the batch id.
        let restored = notes_restore_node(vault_path.clone(), BATCH_A_ID.to_string(), None)
            .expect("restore one batch member");
        let mut active = restored
            .workspace
            .nodes
            .iter()
            .map(|node| node.id.clone())
            .collect::<Vec<_>>();
        active.sort();
        assert_eq!(
            active,
            vec![BATCH_A_ID.to_string(), BATCH_C_ID.to_string()]
        );
        assert!(deleted_batch_id_of(&vault_path, BATCH_B_ID).is_some());
        assert!(deleted_batch_id_of(&vault_path, BATCH_D_ID).is_some());
    }

    #[test]
    fn batch_move_places_the_selection_as_a_contiguous_ordered_block() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        // Target parent D already holds one child (A) so we can prove the moved
        // block lands contiguously after it.
        seed_batch_node(&vault_path, BATCH_D_ID, None, None);
        seed_batch_node(&vault_path, BATCH_A_ID, Some(BATCH_D_ID), None);
        // Three roots to move, in document order B, C, then the missing-id stand-in.
        seed_batch_node(&vault_path, BATCH_B_ID, None, Some(BATCH_D_ID));
        seed_batch_node(&vault_path, BATCH_C_ID, None, Some(BATCH_B_ID));
        seed_batch_node(&vault_path, BATCH_MISSING_ID, None, Some(BATCH_C_ID));

        let mutation = notes_apply_batch(
            vault_path.clone(),
            ApplyBatchInput {
                node_ids: vec![
                    BATCH_B_ID.to_string(),
                    BATCH_C_ID.to_string(),
                    BATCH_MISSING_ID.to_string(),
                ],
                op: BatchOp::Move {
                    parent_id: Some(BATCH_D_ID.to_string()),
                    after_id: Some(BATCH_A_ID.to_string()),
                },
            },
            Some(batch_op_context(REPLACEMENT_ENTRY_ID, "batchMove")),
        )
        .expect("batch move");

        assert_eq!(
            mutation.history_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        // Block is contiguous and keeps the requested order after the anchor.
        assert_eq!(
            active_child_ids(&vault_path, Some(BATCH_D_ID)),
            vec![
                BATCH_A_ID.to_string(),
                BATCH_B_ID.to_string(),
                BATCH_C_ID.to_string(),
                BATCH_MISSING_ID.to_string()
            ]
        );
        // Only the (unmoved) target parent remains at the root level.
        assert_eq!(
            active_child_ids(&vault_path, None),
            vec![BATCH_D_ID.to_string()]
        );
    }

    #[test]
    fn batch_move_under_a_live_descendant_rejects_the_whole_batch() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        // A has a live descendant A_child; B is an unrelated root.
        seed_batch_node(&vault_path, BATCH_A_ID, None, None);
        seed_batch_node(&vault_path, BATCH_C_ID, Some(BATCH_A_ID), None);
        seed_batch_node(&vault_path, BATCH_B_ID, None, Some(BATCH_A_ID));

        // Moving [B, A] under A's own descendant must reject the entire batch,
        // even though moving B alone would be legal.
        let error = notes_apply_batch(
            vault_path.clone(),
            ApplyBatchInput {
                node_ids: vec![BATCH_B_ID.to_string(), BATCH_A_ID.to_string()],
                op: BatchOp::Move {
                    parent_id: Some(BATCH_C_ID.to_string()),
                    after_id: None,
                },
            },
            Some(batch_op_context(REPLACEMENT_ENTRY_ID, "batchMove")),
        )
        .expect_err("descendant move must be rejected");
        assert_eq!(error, "A Note node cannot be moved under a live descendant.");

        // Nothing changed and no history entry was written.
        assert_eq!(
            active_child_ids(&vault_path, None),
            vec![BATCH_A_ID.to_string(), BATCH_B_ID.to_string()]
        );
        assert_eq!(
            active_child_ids(&vault_path, Some(BATCH_A_ID)),
            vec![BATCH_C_ID.to_string()]
        );
        assert_eq!(history_entry_count(&vault_path), 0);
    }

    #[test]
    fn batch_indent_reparents_each_node_under_its_prior_unselected_sibling() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        // Parent D with children A, B, C, (missing-id) in order.
        seed_batch_node(&vault_path, BATCH_D_ID, None, None);
        seed_batch_node(&vault_path, BATCH_A_ID, Some(BATCH_D_ID), None);
        seed_batch_node(&vault_path, BATCH_B_ID, Some(BATCH_D_ID), Some(BATCH_A_ID));
        seed_batch_node(&vault_path, BATCH_C_ID, Some(BATCH_D_ID), Some(BATCH_B_ID));
        seed_batch_node(&vault_path, BATCH_MISSING_ID, Some(BATCH_D_ID), Some(BATCH_C_ID));

        // Selecting first child A is ineligible (no prior sibling) -> no-op.
        let noop = notes_apply_batch(
            vault_path.clone(),
            ApplyBatchInput {
                node_ids: vec![BATCH_A_ID.to_string()],
                op: BatchOp::Indent,
            },
            Some(batch_op_context(NOOP_ENTRY_ID, "batchIndent")),
        )
        .expect("indent first child is a no-op");
        assert_eq!(noop.history_entry_id, None);
        assert_eq!(
            active_child_ids(&vault_path, Some(BATCH_D_ID)),
            vec![
                BATCH_A_ID.to_string(),
                BATCH_B_ID.to_string(),
                BATCH_C_ID.to_string(),
                BATCH_MISSING_ID.to_string()
            ]
        );

        // B and C both indent under their nearest unselected prior sibling (A),
        // preserving their order under A.
        let mutation = notes_apply_batch(
            vault_path.clone(),
            ApplyBatchInput {
                node_ids: vec![BATCH_B_ID.to_string(), BATCH_C_ID.to_string()],
                op: BatchOp::Indent,
            },
            Some(batch_op_context(REPLACEMENT_ENTRY_ID, "batchIndent")),
        )
        .expect("batch indent");
        assert_eq!(
            mutation.history_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        assert_eq!(
            active_child_ids(&vault_path, Some(BATCH_D_ID)),
            vec![BATCH_A_ID.to_string(), BATCH_MISSING_ID.to_string()]
        );
        assert_eq!(
            active_child_ids(&vault_path, Some(BATCH_A_ID)),
            vec![BATCH_B_ID.to_string(), BATCH_C_ID.to_string()]
        );
    }

    #[test]
    fn batch_outdent_lifts_each_node_after_its_old_parent() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        // Grandparent A > parent B > children C, (missing-id).
        seed_batch_node(&vault_path, BATCH_A_ID, None, None);
        seed_batch_node(&vault_path, BATCH_B_ID, Some(BATCH_A_ID), None);
        seed_batch_node(&vault_path, BATCH_C_ID, Some(BATCH_B_ID), None);
        seed_batch_node(&vault_path, BATCH_MISSING_ID, Some(BATCH_B_ID), Some(BATCH_C_ID));

        // A root node cannot outdent (no parent) -> no-op.
        let noop = notes_apply_batch(
            vault_path.clone(),
            ApplyBatchInput {
                node_ids: vec![BATCH_A_ID.to_string()],
                op: BatchOp::Outdent,
            },
            Some(batch_op_context(NOOP_ENTRY_ID, "batchOutdent")),
        )
        .expect("outdent root is a no-op");
        assert_eq!(noop.history_entry_id, None);
        assert_eq!(
            active_child_ids(&vault_path, None),
            vec![BATCH_A_ID.to_string()]
        );

        // C and its sibling outdent to the grandparent, landing after B in order.
        let mutation = notes_apply_batch(
            vault_path.clone(),
            ApplyBatchInput {
                node_ids: vec![BATCH_C_ID.to_string(), BATCH_MISSING_ID.to_string()],
                op: BatchOp::Outdent,
            },
            Some(batch_op_context(REPLACEMENT_ENTRY_ID, "batchOutdent")),
        )
        .expect("batch outdent");
        assert_eq!(
            mutation.history_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        assert_eq!(
            active_child_ids(&vault_path, Some(BATCH_A_ID)),
            vec![
                BATCH_B_ID.to_string(),
                BATCH_C_ID.to_string(),
                BATCH_MISSING_ID.to_string()
            ]
        );
        assert!(active_child_ids(&vault_path, Some(BATCH_B_ID)).is_empty());
    }

    #[test]
    fn batch_with_one_invalid_node_rolls_back_the_committed_work() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        seed_batch_node(&vault_path, BATCH_A_ID, None, None);
        seed_batch_node(&vault_path, BATCH_B_ID, None, Some(BATCH_A_ID));

        // A and B are completed inside the transaction before the missing third
        // node fails validation; the failure must roll their completions back.
        let error = notes_apply_batch(
            vault_path.clone(),
            ApplyBatchInput {
                node_ids: vec![
                    BATCH_A_ID.to_string(),
                    BATCH_B_ID.to_string(),
                    BATCH_MISSING_ID.to_string(),
                ],
                op: BatchOp::Complete { completed: true },
            },
            Some(batch_op_context(REPLACEMENT_ENTRY_ID, "batchComplete")),
        )
        .expect_err("missing node aborts the batch");
        assert!(error.contains("does not exist"));

        let workspace = notes_load_workspace(vault_path.clone(), NotesWorkspaceScope::Active)
            .expect("reload workspace after aborted batch");
        assert!(
            workspace.nodes.iter().all(|node| node.completed_at.is_none()),
            "aborted batch left a node completed"
        );
        assert_eq!(history_entry_count(&vault_path), 0);
    }

    #[test]
    fn expand_all_returns_one_atomic_subtree_mutation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        for (id, parent_id) in [
            (ROOT_ID, None),
            (SPLIT_ID, Some(ROOT_ID)),
            (EMPTY_ID, Some(SPLIT_ID)),
        ] {
            notes_create_node(
                vault_path.clone(),
                CreateNodeInput {
                    id: id.to_string(),
                    parent_id: parent_id.map(str::to_string),
                    after_id: None,
                    title: id.to_string(),
                    note: String::new(),
                },
                None,
            )
            .expect("seed subtree node");
        }
        notes_collapse_all(vault_path.clone(), ROOT_ID.to_string(), None)
            .expect("seed collapsed subtree");

        let mutation = notes_expand_all(
            vault_path,
            ROOT_ID.to_string(),
            Some(NotesHistoryContext {
                session_id: SESSION_ID.to_string(),
                entry_id: REPLACEMENT_ENTRY_ID.to_string(),
                command_kind: "expandAll".to_string(),
            }),
        )
        .expect("expand subtree");

        assert_eq!(
            mutation.history_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        assert!(mutation
            .workspace
            .nodes
            .iter()
            .all(|node| !node.is_collapsed));
    }

    #[test]
    fn sort_subtree_ascending_is_atomic_undoable_and_preserves_node_metadata() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        for (id, parent_id, title, note) in [
            (ROOT_ID, None, "root", ""),
            (
                SPLIT_ID,
                Some(ROOT_ID),
                "beta",
                "details #Roadmap 2026-07-14",
            ),
            (EMPTY_ID, Some(ROOT_ID), "Alpha", "untouched"),
        ] {
            notes_create_node(
                vault_path.clone(),
                CreateNodeInput {
                    id: id.to_string(),
                    parent_id: parent_id.map(str::to_string),
                    after_id: None,
                    title: title.to_string(),
                    note: note.to_string(),
                },
                None,
            )
            .expect("seed sortable node");
        }
        notes_toggle_complete(vault_path.clone(), SPLIT_ID.to_string(), None)
            .expect("complete sortable child");
        let connection = connect_notes_db(&vault_path).expect("open seeded vault");
        connection
            .execute(
                "INSERT INTO notes_attachments (\
                   id, node_id, sort_key, relative_path, content_hash, original_name, mime_type, \
                   byte_size, intrinsic_width, intrinsic_height, display_width, created_at, updated_at\
                 ) VALUES (\
                   ?1, ?2, 1024, 'notes-assets/a.png', ?3, 'a.png', 'image/png', \
                   1, 1, 1, 160, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z'\
                 )",
                params![EMPTY_ID, SPLIT_ID, "a".repeat(64)],
            )
            .expect("seed attachment metadata");
        let indexed_before: (i64, i64) = connection
            .query_row(
                "SELECT \
                   (SELECT COUNT(*) FROM notes_tags WHERE node_id = ?1), \
                   (SELECT COUNT(*) FROM notes_dates WHERE node_id = ?1)",
                [SPLIT_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read derived rows before sort");
        drop(connection);

        let mutation = notes_sort_subtree_ascending(
            vault_path.clone(),
            ROOT_ID.to_string(),
            Some(NotesHistoryContext {
                session_id: SESSION_ID.to_string(),
                entry_id: REPLACEMENT_ENTRY_ID.to_string(),
                command_kind: "sortSubtreeAscending".to_string(),
            }),
        )
        .expect("sort subtree ascending");

        assert_eq!(
            mutation.history_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        assert_eq!(
            mutation
                .workspace
                .nodes
                .iter()
                .filter(|node| node.parent_id.as_deref() == Some(ROOT_ID))
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![EMPTY_ID, SPLIT_ID]
        );
        let completed = mutation
            .workspace
            .nodes
            .iter()
            .find(|node| node.id == SPLIT_ID)
            .expect("completed child after sort");
        assert_eq!(completed.note, "details #Roadmap 2026-07-14");
        assert!(completed.completed_at.is_some());
        assert_eq!(
            mutation
                .workspace
                .attachments_by_node_id
                .get(SPLIT_ID)
                .map(Vec::len),
            Some(1)
        );

        let connection = connect_notes_db(&vault_path).expect("reopen sorted vault");
        let indexed_after: (i64, i64) = connection
            .query_row(
                "SELECT \
                   (SELECT COUNT(*) FROM notes_tags WHERE node_id = ?1), \
                   (SELECT COUNT(*) FROM notes_dates WHERE node_id = ?1)",
                [SPLIT_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read derived rows after sort");
        assert_eq!(indexed_after, indexed_before);
        drop(connection);

        let undone = notes_undo(
            vault_path,
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("undo subtree sort");
        assert_eq!(
            undone
                .workspace
                .nodes
                .iter()
                .filter(|node| node.parent_id.as_deref() == Some(ROOT_ID))
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![SPLIT_ID, EMPTY_ID]
        );
        assert_eq!(
            undone
                .workspace
                .attachments_by_node_id
                .get(SPLIT_ID)
                .map(Vec::len),
            Some(1)
        );
    }

    #[test]
    fn sort_subtree_descending_returns_one_atomic_subtree_mutation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        for (id, parent_id, title) in [
            (ROOT_ID, None, "root"),
            (SPLIT_ID, Some(ROOT_ID), "Alpha"),
            (EMPTY_ID, Some(ROOT_ID), "beta"),
        ] {
            notes_create_node(
                vault_path.clone(),
                CreateNodeInput {
                    id: id.to_string(),
                    parent_id: parent_id.map(str::to_string),
                    after_id: None,
                    title: title.to_string(),
                    note: String::new(),
                },
                None,
            )
            .expect("seed sortable node");
        }

        let mutation = notes_sort_subtree_descending(
            vault_path,
            ROOT_ID.to_string(),
            Some(NotesHistoryContext {
                session_id: SESSION_ID.to_string(),
                entry_id: REPLACEMENT_ENTRY_ID.to_string(),
                command_kind: "sortSubtreeDescending".to_string(),
            }),
        )
        .expect("sort subtree descending");

        assert_eq!(
            mutation.history_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        assert_eq!(
            mutation
                .workspace
                .nodes
                .iter()
                .filter(|node| node.parent_id.as_deref() == Some(ROOT_ID))
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![EMPTY_ID, SPLIT_ID]
        );
    }

    #[test]
    fn no_op_subtree_commands_return_atomic_results_without_polluting_history() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        for (id, parent_id, title) in [
            (ROOT_ID, None, "root"),
            (SPLIT_ID, Some(ROOT_ID), "Alpha"),
            (EMPTY_ID, Some(ROOT_ID), "beta"),
        ] {
            notes_create_node(
                vault_path.clone(),
                CreateNodeInput {
                    id: id.to_string(),
                    parent_id: parent_id.map(str::to_string),
                    after_id: None,
                    title: title.to_string(),
                    note: String::new(),
                },
                None,
            )
            .expect("seed no-op subtree");
        }
        let first = notes_collapse_all(
            vault_path.clone(),
            ROOT_ID.to_string(),
            Some(NotesHistoryContext {
                session_id: SESSION_ID.to_string(),
                entry_id: REPLACEMENT_ENTRY_ID.to_string(),
                command_kind: "collapseAll".to_string(),
            }),
        )
        .expect("initial collapse");
        assert_eq!(
            first.history_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );

        let collapse_noop = notes_collapse_all(
            vault_path.clone(),
            ROOT_ID.to_string(),
            Some(NotesHistoryContext {
                session_id: SESSION_ID.to_string(),
                entry_id: NOOP_ENTRY_ID.to_string(),
                command_kind: "collapseAll".to_string(),
            }),
        )
        .expect("no-op collapse");
        assert_eq!(collapse_noop.history_entry_id, None);
        assert!(collapse_noop.can_undo);

        let sorted_noop = notes_sort_subtree_ascending(
            vault_path.clone(),
            ROOT_ID.to_string(),
            Some(NotesHistoryContext {
                session_id: SESSION_ID.to_string(),
                entry_id: NOOP_ENTRY_ID.to_string(),
                command_kind: "sortSubtreeAscending".to_string(),
            }),
        )
        .expect("already sorted subtree");
        assert_eq!(sorted_noop.history_entry_id, None);
        assert!(sorted_noop.can_undo);

        let undone = notes_undo(
            vault_path,
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("undo latest real mutation");
        assert_eq!(
            undone.replayed_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        assert!(undone.workspace.nodes.iter().all(|node| !node.is_collapsed));
    }

    #[test]
    fn subtree_commands_reject_archived_trashed_and_cross_vault_ids() {
        type Command =
            fn(String, String, Option<NotesHistoryContext>) -> Result<NotesMutationResult, String>;
        let commands: [(&str, Command); 4] = [
            ("expand", notes_expand_all),
            ("collapse", notes_collapse_all),
            ("sort ascending", notes_sort_subtree_ascending),
            ("sort descending", notes_sort_subtree_descending),
        ];
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        notes_create_node(
            vault_path.clone(),
            CreateNodeInput {
                id: ROOT_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "root".to_string(),
                note: String::new(),
            },
            None,
        )
        .expect("seed lifecycle root");
        notes_archive_node(vault_path.clone(), ROOT_ID.to_string(), None).expect("archive root");
        for (label, command) in commands {
            let error = command(vault_path.clone(), ROOT_ID.to_string(), None).expect_err(label);
            assert!(error.contains("archived"), "{label}: {error}");
        }

        notes_unarchive_node(vault_path.clone(), ROOT_ID.to_string(), None)
            .expect("unarchive root");
        notes_soft_delete_node(vault_path.clone(), ROOT_ID.to_string(), None).expect("trash root");
        for (label, command) in commands {
            let error = command(vault_path.clone(), ROOT_ID.to_string(), None).expect_err(label);
            assert!(error.contains("trash"), "{label}: {error}");
        }

        let other_temp_dir = tempfile::tempdir().expect("other temp dir");
        let other_vault_path = other_temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(other_vault_path.clone()).expect("initialize other vault");
        for (label, command) in commands {
            let error =
                command(other_vault_path.clone(), ROOT_ID.to_string(), None).expect_err(label);
            assert!(error.contains("does not exist"), "{label}: {error}");
        }
    }

    #[test]
    fn cyclic_subtree_collapse_rejects_without_history_or_partial_updates() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        for (id, parent_id) in [(ROOT_ID, None), (SPLIT_ID, Some(ROOT_ID))] {
            notes_create_node(
                vault_path.clone(),
                CreateNodeInput {
                    id: id.to_string(),
                    parent_id: parent_id.map(str::to_string),
                    after_id: None,
                    title: id.to_string(),
                    note: String::new(),
                },
                None,
            )
            .expect("seed cycle node");
        }
        let connection = connect_notes_db(&vault_path).expect("open cycle vault");
        connection
            .execute(
                "UPDATE notes_nodes SET parent_id = ?1 WHERE id = ?2",
                params![SPLIT_ID, ROOT_ID],
            )
            .expect("create command cycle");
        drop(connection);

        let error = notes_collapse_all(
            vault_path.clone(),
            ROOT_ID.to_string(),
            Some(NotesHistoryContext {
                session_id: SESSION_ID.to_string(),
                entry_id: REPLACEMENT_ENTRY_ID.to_string(),
                command_kind: "collapseAll".to_string(),
            }),
        )
        .expect_err("cyclic collapse");

        assert_eq!(
            error,
            "The Notes tree contains a cycle and cannot be expanded or collapsed."
        );
        assert_eq!(
            notes_history_status(vault_path.clone(), SESSION_ID.to_string())
                .expect("cycle history status"),
            NotesHistoryStatus::default()
        );
        let connection = connect_notes_db(&vault_path).expect("reopen cycle vault");
        let collapsed_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_nodes WHERE is_collapsed = 1",
                [],
                |row| row.get(0),
            )
            .expect("count collapsed cycle nodes");
        assert_eq!(collapsed_count, 0);
    }

    #[test]
    fn attachment_import_limits_reject_before_metadata_history_or_file_publication() {
        for (label, existing_count, target_node_id, expected_error) in [
            (
                "per-node",
                MAX_NOTE_ATTACHMENTS_PER_NODE,
                ROOT_ID,
                "A Note node can contain at most 128 attachments.",
            ),
            (
                "vault",
                MAX_NOTE_ATTACHMENTS_PER_VAULT,
                "55555555-5555-4555-8555-555555555555",
                "A Notes vault can contain at most 512 attachments.",
            ),
        ] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let vault_path = temp_dir.path().to_string_lossy().into_owned();
            notes_initialize(vault_path.clone()).expect("initialize");
            let node_ids = [
                ROOT_ID,
                SPLIT_ID,
                EMPTY_ID,
                "44444444-4444-4444-8444-444444444444",
                "55555555-5555-4555-8555-555555555555",
            ];
            for (index, node_id) in node_ids.iter().enumerate() {
                notes_create_node(
                    vault_path.clone(),
                    CreateNodeInput {
                        id: (*node_id).to_string(),
                        parent_id: None,
                        after_id: (index > 0).then(|| node_ids[index - 1].to_string()),
                        title: (*node_id).to_string(),
                        note: String::new(),
                    },
                    None,
                )
                .expect("seed import limit node");
            }
            let connection = connect_notes_db(&vault_path).expect("open limit vault");
            for index in 0..existing_count {
                let node_id = if label == "per-node" {
                    ROOT_ID
                } else {
                    node_ids[usize::try_from(index / MAX_NOTE_ATTACHMENTS_PER_NODE)
                        .expect("limit node index")]
                };
                insert_limit_attachment_metadata(&connection, index, node_id);
            }
            drop(connection);
            let source = temp_dir.path().join(format!("{label}.png"));
            fs::write(&source, encoded_png(2, 2)).expect("write import limit source");
            let before_entries = asset_directory_entries(&vault_path);

            let error = notes_import_attachment(
                vault_path.clone(),
                ImportAttachmentInput {
                    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee".to_string(),
                    node_id: target_node_id.to_string(),
                    source_path: source.to_string_lossy().into_owned(),
                    initial_max_display_width: 2,
                },
                Some(NotesHistoryContext {
                    session_id: SESSION_ID.to_string(),
                    entry_id: REPLACEMENT_ENTRY_ID.to_string(),
                    command_kind: "importAttachment".to_string(),
                }),
            )
            .expect_err(label);

            assert_eq!(error, expected_error, "{label}");
            let connection = connect_notes_db(&vault_path).expect("reopen limit vault");
            let count: i64 = connection
                .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                    row.get(0)
                })
                .expect("count rejected import metadata");
            assert_eq!(count, existing_count, "{label}");
            let rejected_exists: bool = connection
                .query_row(
                    "SELECT EXISTS(\
                       SELECT 1 FROM notes_attachments \
                       WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'\
                     )",
                    [],
                    |row| row.get(0),
                )
                .expect("check rejected attachment ID");
            assert!(!rejected_exists, "{label}");
            drop(connection);
            assert_eq!(
                asset_directory_entries(&vault_path),
                before_entries,
                "{label}"
            );
            assert!(source.exists(), "{label} source remains untouched");
            assert_eq!(
                notes_history_status(vault_path, SESSION_ID.to_string())
                    .expect("history status after rejected import"),
                NotesHistoryStatus::default(),
                "{label}"
            );
        }
    }

    #[test]
    fn removed_attachment_history_does_not_consume_live_import_capacity() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        notes_create_node(
            vault_path.clone(),
            CreateNodeInput {
                id: ROOT_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "root".to_string(),
                note: String::new(),
            },
            None,
        )
        .expect("seed capacity root");
        let connection = connect_notes_db(&vault_path).expect("open capacity vault");
        let mut first_attachment_id = String::new();
        for index in 0..MAX_NOTE_ATTACHMENTS_PER_NODE {
            let id = insert_limit_attachment_metadata(&connection, index, ROOT_ID);
            if index == 0 {
                first_attachment_id = id;
            }
        }
        drop(connection);
        notes_remove_attachment(
            vault_path.clone(),
            first_attachment_id.clone(),
            Some(NotesHistoryContext {
                session_id: SESSION_ID.to_string(),
                entry_id: REPLACEMENT_ENTRY_ID.to_string(),
                command_kind: "removeAttachment".to_string(),
            }),
        )
        .expect("remove one attachment at capacity");
        let source = temp_dir.path().join("replacement.png");
        fs::write(&source, encoded_png(2, 2)).expect("write replacement source");

        let imported = notes_import_attachment(
            vault_path.clone(),
            ImportAttachmentInput {
                id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee".to_string(),
                node_id: ROOT_ID.to_string(),
                source_path: source.to_string_lossy().into_owned(),
                initial_max_display_width: 2,
            },
            Some(NotesHistoryContext {
                session_id: SESSION_ID.to_string(),
                entry_id: NOOP_ENTRY_ID.to_string(),
                command_kind: "importAttachment".to_string(),
            }),
        )
        .expect("replace removed attachment");

        assert_eq!(imported.history_entry_id.as_deref(), Some(NOOP_ENTRY_ID));
        assert_eq!(
            imported
                .workspace
                .attachments_by_node_id
                .get(ROOT_ID)
                .map(Vec::len),
            Some(usize::try_from(MAX_NOTE_ATTACHMENTS_PER_NODE).expect("node capacity"))
        );
        let connection = connect_notes_db(&vault_path).expect("reopen capacity vault");
        let retained_history: bool = connection
            .query_row(
                "SELECT EXISTS(\
                   SELECT 1 FROM notes_history_changes \
                   WHERE row_id = ?1 AND table_name = 'notes_attachments'\
                 )",
                [first_attachment_id],
                |row| row.get(0),
            )
            .expect("inspect retained attachment history");
        assert!(retained_history);
    }

    #[test]
    fn discovery_commands_return_typed_local_results_and_delete_notes_data() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_create_node(
            vault_path.clone(),
            CreateNodeInput {
                id: ROOT_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "#Roadmap target".to_string(),
                note: String::new(),
            },
            None,
        )
        .expect("create searchable node");

        assert_eq!(
            notes_search(
                vault_path.clone(),
                "target".to_string(),
                NoteSearchScope::Active,
            )
            .expect("search")
            .first()
            .expect("search result")
            .node_id,
            ROOT_ID
        );
        assert_eq!(
            notes_search_structured(
                vault_path.clone(),
                NoteStructuredSearchQuery {
                    text: String::new(),
                    required_tags: vec![NoteSearchTag {
                        prefix: NoteTagPrefix::Hash,
                        normalized_tag: "roadmap".to_string(),
                        display_tag: "Roadmap".to_string(),
                    }],
                    excluded_tags: vec![],
                    or_groups: vec![],
                },
            )
            .expect("structured search")
            .first()
            .expect("structured search result")
            .node_id,
            ROOT_ID
        );
        assert_eq!(
            notes_list_tags(vault_path.clone()).expect("list tags"),
            vec!["roadmap"]
        );
        assert!(
            notes_toggle_star(vault_path.clone(), ROOT_ID.to_string(), None)
                .expect("toggle star")
                .workspace
                .nodes[0]
                .is_starred
        );

        let deletion = notes_delete_database(vault_path.clone()).expect("delete database");
        assert!(!deletion.attachment_cleanup_failed);
        assert!(!crate::notes::repository::notes_db_path(&vault_path).exists());
    }

    #[test]
    fn notes_delete_database_evicts_a_connection_raced_into_the_unlink_window() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_create_node(
            vault_path.clone(),
            CreateNodeInput {
                id: ROOT_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "Doomed".to_string(),
                note: String::new(),
            },
            None,
        )
        .expect("create node before deletion");

        // Arm the hook so a read-only command "slips" into the window between the
        // pre-delete evict and the file removal, reopening the vault and caching a
        // connection to the inode deletion is about to unlink.
        arm_delete_database_race();
        let deletion = notes_delete_database(vault_path.clone()).expect("delete database");
        assert!(!deletion.attachment_cleanup_failed);
        assert!(
            !crate::notes::repository::notes_db_path(&vault_path).exists(),
            "deletion must unlink the database file"
        );

        let raced = take_delete_database_raced_connection()
            .expect("the armed hook must have acquired a connection in the unlink window");

        // Without the post-delete evict this raced connection to the unlinked
        // inode would stay cached and every later command would reuse it: reads
        // would see deleted data and writes would vanish because they never reach
        // a file at `notes_db_path`. The fix drops it, so the next acquisition
        // reconnects against a fresh on-disk database instead.
        let reacquired =
            acquire_notes_connection(&vault_path).expect("reacquire after deletion");
        assert!(
            !std::sync::Arc::ptr_eq(&raced, &reacquired),
            "the raced connection to the unlinked inode must not be handed back after deletion"
        );

        // The fresh connection must reconnect against a real on-disk database, so
        // a write persists and is readable through a later acquisition.
        notes_create_node(
            vault_path.clone(),
            CreateNodeInput {
                id: SPLIT_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "Reborn".to_string(),
                note: String::new(),
            },
            None,
        )
        .expect("create node after deletion");
        // File existence alone is a weak check: the acquire above already recreated
        // the file and schema via `connect_notes_db`, so it would hold even if the
        // write had vanished into the unlinked inode. Read the node back through a
        // fresh acquisition to prove the write actually reached the live database.
        let reborn = notes_load_workspace(vault_path.clone(), NotesWorkspaceScope::Active)
            .expect("load workspace after the reborn write");
        assert!(
            reborn
                .nodes
                .iter()
                .any(|node| node.id == SPLIT_ID && node.title == "Reborn"),
            "the write after deletion must persist and be readable through a fresh acquisition"
        );
        assert!(
            crate::notes::repository::notes_db_path(&vault_path).exists(),
            "a write after deletion must recreate the database file on disk"
        );
    }

    #[test]
    fn notes_date_search_command_uses_the_injected_local_today_provider() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_create_node(
            vault_path.clone(),
            CreateNodeInput {
                id: ROOT_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "07/12/2026".to_string(),
                note: String::new(),
            },
            None,
        )
        .expect("create dated node");

        let results = notes_search_with_provider(
            vault_path,
            "tomorrow".to_string(),
            NoteSearchScope::Active,
            &FixedLocalToday,
        )
        .expect("search with injected today");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].matched_field, NoteSearchMatchedField::Date);
    }

    fn command_search_tag(index: usize) -> NoteSearchTag {
        NoteSearchTag {
            prefix: if index % 2 == 0 {
                NoteTagPrefix::Hash
            } else {
                NoteTagPrefix::Mention
            },
            normalized_tag: format!("tag-{index}"),
            display_tag: format!("Tag-{index}"),
        }
    }

    fn command_search_query(required_tags: Vec<NoteSearchTag>) -> NoteStructuredSearchQuery {
        NoteStructuredSearchQuery {
            text: String::new(),
            required_tags,
            excluded_tags: vec![],
            or_groups: vec![],
        }
    }

    #[test]
    fn notes_tag_command_validates_canonical_bodies_and_exact_limits_before_storage() {
        let normal_tags = (0..63).map(command_search_tag).collect::<Vec<_>>();
        let x = NoteSearchTag {
            prefix: NoteTagPrefix::Hash,
            normalized_tag: "x".to_string(),
            display_tag: "X".to_string(),
        };
        let boundary_tags = normal_tags
            .iter()
            .cloned()
            .chain([x.clone()])
            .collect::<Vec<_>>();
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        assert!(
            notes_search_structured(vault_path, command_search_query(boundary_tags.clone()))
                .expect("64 canonical command tags")
                .is_empty()
        );

        let malformed = NoteSearchTag {
            prefix: NoteTagPrefix::Hash,
            normalized_tag: "##x".to_string(),
            display_tag: "##x".to_string(),
        };
        let error = notes_search_structured(
            String::new(),
            command_search_query(boundary_tags.iter().cloned().chain([malformed]).collect()),
        )
        .expect_err("malformed command tag before storage");
        assert_eq!(
            error,
            "Structured Notes search tag normalizedTag must be a canonical tag body."
        );

        for normalized_tag in ["#x", "##x", "@x", "#@x", "@#x"] {
            let error = notes_search_structured(
                String::new(),
                command_search_query(vec![NoteSearchTag {
                    prefix: NoteTagPrefix::Hash,
                    normalized_tag: normalized_tag.to_string(),
                    display_tag: normalized_tag.to_string(),
                }]),
            )
            .unwrap_err();
            assert_eq!(
                error,
                "Structured Notes search tag normalizedTag must be a canonical tag body."
            );
        }

        let error = notes_search_structured(
            String::new(),
            command_search_query(
                boundary_tags
                    .into_iter()
                    .chain([command_search_tag(63)])
                    .collect(),
            ),
        )
        .expect_err("65 canonical command tags before storage");
        assert_eq!(
            error,
            "Structured Notes search has more than 64 unique tag alternatives."
        );
    }

    #[test]
    fn notes_tag_workspace_command_rejects_noncanonical_body_before_storage() {
        let error = notes_load_workspace(
            String::new(),
            NotesWorkspaceScope::Tags {
                tags: vec![NoteTagFilter {
                    prefix: NoteTagPrefix::Hash,
                    normalized_tag: "#x".to_string(),
                }],
            },
        )
        .expect_err("invalid typed tag scope before storage");

        assert_eq!(
            error,
            "Structured Notes search tag normalizedTag must be a canonical tag body."
        );
    }

    #[test]
    fn archive_commands_apply_native_scopes_and_counted_tag_visibility() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_create_node(
            vault_path.clone(),
            CreateNodeInput {
                id: ROOT_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "#Roadmap @Minji".to_string(),
                note: String::new(),
            },
            None,
        )
        .expect("create tagged root");

        assert!(
            notes_archive_node(vault_path.clone(), ROOT_ID.to_string(), None)
                .expect("archive root")
                .workspace
                .nodes
                .is_empty()
        );
        let archived = notes_load_workspace(vault_path.clone(), NotesWorkspaceScope::Archive)
            .expect("archive scope");
        assert_eq!(archived.nodes.len(), 1);
        assert_eq!(archived.nodes[0].archive_root_id.as_deref(), Some(ROOT_ID));
        let tag_scope = NotesWorkspaceScope::Tags {
            tags: vec![
                NoteTagFilter {
                    prefix: NoteTagPrefix::Hash,
                    normalized_tag: "roadmap".to_string(),
                },
                NoteTagFilter {
                    prefix: NoteTagPrefix::Mention,
                    normalized_tag: "minji".to_string(),
                },
            ],
        };
        assert!(notes_load_workspace(vault_path.clone(), tag_scope.clone())
            .expect("archived tag scope")
            .nodes
            .is_empty());
        assert!(notes_list_tags_with_counts(vault_path.clone())
            .expect("archived tag counts")
            .is_empty());

        let active = notes_unarchive_node(vault_path.clone(), ROOT_ID.to_string(), None)
            .expect("unarchive root");
        assert_eq!(active.workspace.nodes.len(), 1);
        assert_eq!(
            notes_load_workspace(vault_path.clone(), tag_scope)
                .expect("active tag scope")
                .nodes
                .len(),
            1
        );
        assert_eq!(
            notes_list_tags_with_counts(vault_path).expect("active tag counts"),
            vec![
                NoteTagSummary {
                    prefix: NoteTagPrefix::Hash,
                    normalized_tag: "roadmap".to_string(),
                    display_tag: "Roadmap".to_string(),
                    count: 1,
                },
                NoteTagSummary {
                    prefix: NoteTagPrefix::Mention,
                    normalized_tag: "minji".to_string(),
                    display_tag: "Minji".to_string(),
                    count: 1,
                },
            ]
        );
    }

    #[test]
    fn markdown_export_conflict_is_reported_before_notes_storage_is_opened() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("existing.md");
        std::fs::write(&destination, b"keep me").expect("seed destination");

        let error = notes_export_markdown(
            "   ".to_string(),
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            false,
        )
        .expect_err("occupied destination");

        assert_eq!(error, "Destination already exists.");
        assert_eq!(
            std::fs::read(destination).expect("read destination"),
            b"keep me"
        );
    }

    #[test]
    fn markdown_export_rejects_an_overwrite_directory_before_opening_storage() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("missing-vault");
        let destination = temp_dir.path().join("export.md");
        std::fs::create_dir(&destination).expect("seed destination directory");

        let error = notes_export_markdown(
            vault_path.to_string_lossy().into_owned(),
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            true,
        )
        .expect_err("directory destination");

        assert_eq!(error, "File path must name a file.");
        assert!(!vault_path.join(".yonalist").exists());
        assert!(destination.is_dir());
    }

    #[test]
    fn markdown_export_rejects_a_no_overwrite_directory_by_shape_before_opening_storage() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("missing-vault");
        let destination = temp_dir.path().join("export.md");
        std::fs::create_dir(&destination).expect("seed destination directory");

        let error = notes_export_markdown(
            vault_path.to_string_lossy().into_owned(),
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            false,
        )
        .expect_err("directory destination");

        assert_eq!(error, "File path must name a file.");
        assert!(!vault_path.join(".yonalist").exists());
        assert!(destination.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn markdown_export_follows_an_overwrite_symlink_to_a_directory_before_opening_storage() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("missing-vault");
        let target_directory = temp_dir.path().join("target-directory");
        let destination = temp_dir.path().join("export.md");
        std::fs::create_dir(&target_directory).expect("seed target directory");
        symlink(&target_directory, &destination).expect("seed directory symlink");

        let error = notes_export_markdown(
            vault_path.to_string_lossy().into_owned(),
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            true,
        )
        .expect_err("directory symlink destination");

        assert_eq!(error, "File path must name a file.");
        assert!(!vault_path.join(".yonalist").exists());
        assert!(destination.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn markdown_export_preflight_treats_a_dangling_symlink_as_occupied() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("missing-vault");
        let destination = temp_dir.path().join("dangling.md");
        symlink("missing-target", &destination).expect("seed dangling symlink");

        let error = notes_export_markdown(
            vault_path.to_string_lossy().into_owned(),
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            false,
        )
        .expect_err("dangling destination");

        assert_eq!(error, "Destination already exists.");
        assert!(!vault_path.join(".yonalist").exists());
        assert!(std::fs::symlink_metadata(destination).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn markdown_export_overwrite_replaces_a_dangling_symlink() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        let destination = temp_dir.path().join("dangling.md");
        symlink("missing-target", &destination).expect("seed dangling symlink");

        notes_export_markdown(
            vault_path_string,
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            true,
        )
        .expect("replace dangling destination");

        assert!(std::fs::symlink_metadata(&destination)
            .expect("destination metadata")
            .file_type()
            .is_file());
        assert!(std::fs::read_to_string(destination)
            .expect("read Markdown")
            .contains("# Project"));
    }

    #[test]
    fn markdown_export_validates_root_and_destination_before_opening_storage() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("missing-vault");
        let destination = temp_dir.path().join("export.md");

        let invalid_root = notes_export_markdown(
            vault_path.to_string_lossy().into_owned(),
            "not-a-uuid".to_string(),
            destination.to_string_lossy().into_owned(),
            false,
        )
        .expect_err("invalid root");
        assert_eq!(invalid_root, "Note ID must be a canonical UUID v4 string.");

        let invalid_destination = notes_export_markdown(
            vault_path.to_string_lossy().into_owned(),
            ROOT_ID.to_string(),
            String::new(),
            false,
        )
        .expect_err("invalid destination");
        assert_eq!(invalid_destination, "File path must name a file.");
        assert!(!vault_path.join(".yonalist").exists());
    }

    #[test]
    fn markdown_export_writes_active_snapshot_bytes_and_returns_the_typed_result() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        let destination = temp_dir.path().join("nested/project.md");
        let destination_string = destination.to_string_lossy().into_owned();

        let result = notes_export_markdown(
            vault_path_string.clone(),
            ROOT_ID.to_string(),
            destination_string.clone(),
            false,
        )
        .expect("export Markdown");

        assert_eq!(result.destination, destination_string);
        assert_eq!(result.format, NotesExportFormat::Markdown);
        let markdown = std::fs::read_to_string(&destination).expect("read Markdown export");
        assert!(markdown.contains("- [ ] Project <!-- yonalist-node-id:"));
        assert!(markdown.contains("  - [x] Completed child <!-- yonalist-node-id:"));
        assert!(markdown.contains("    - [ ] Visible below collapsed <!-- yonalist-node-id:"));
        assert!(!markdown.contains("Deleted child"));
        assert!(markdown.ends_with('\n'));
        assert!(!markdown.ends_with("\n\n"));

        std::fs::write(&destination, b"stale").expect("replace with stale destination");
        notes_export_markdown(
            vault_path_string,
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            true,
        )
        .expect("overwrite Markdown");
        assert_ne!(
            std::fs::read(&destination).expect("read overwritten Markdown"),
            b"stale"
        );
    }

    #[test]
    fn native_exports_reject_an_archived_root_without_writing_output() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        let connection = connect_notes_db(&vault_path_string).expect("open export database");
        connection
            .execute(
                "UPDATE notes_nodes SET archived_at = '2026-07-12T00:00:00.000Z', \
                 archive_root_id = ?1 WHERE id = ?1",
                [ROOT_ID],
            )
            .expect("archive export root");
        drop(connection);
        let markdown_destination = temp_dir.path().join("archived.md");
        let pdf_destination = temp_dir.path().join("archived.pdf");

        let markdown_error = notes_export_markdown(
            vault_path_string.clone(),
            ROOT_ID.to_string(),
            markdown_destination.to_string_lossy().into_owned(),
            false,
        )
        .expect_err("archived Markdown root");
        let pdf_error = notes_export_pdf(
            vault_path_string,
            ROOT_ID.to_string(),
            pdf_destination.to_string_lossy().into_owned(),
            false,
        )
        .expect_err("archived PDF root");

        let expected =
            format!("Note node {ROOT_ID} is missing, deleted, or archived and cannot be exported.");
        assert_eq!(markdown_error, expected);
        assert_eq!(pdf_error, expected);
        assert!(!markdown_destination.exists());
        assert!(!pdf_destination.exists());
    }

    #[test]
    fn notes_export_attachment_free_formats_do_not_create_asset_storage_metadata() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        let metadata = crate::metadata_dir(&vault_path_string);
        let asset_lock = metadata.join(".notes-assets.lock");
        let asset_directory = metadata.join("notes-assets");
        assert!(!asset_lock.exists());
        assert!(!asset_directory.exists());

        notes_export_markdown(
            vault_path_string.clone(),
            ROOT_ID.to_string(),
            temp_dir
                .path()
                .join("readonly.md")
                .to_string_lossy()
                .into_owned(),
            false,
        )
        .expect("attachment-free Markdown export");
        assert!(!asset_lock.exists());
        assert!(!asset_directory.exists());

        notes_export_pdf(
            vault_path_string,
            ROOT_ID.to_string(),
            temp_dir
                .path()
                .join("readonly.pdf")
                .to_string_lossy()
                .into_owned(),
            false,
        )
        .expect("attachment-free PDF export");
        assert!(!asset_lock.exists());
        assert!(!asset_directory.exists());
    }

    #[test]
    fn notes_export_attachment_free_formats_ignore_uninitializable_asset_storage() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        let metadata = crate::metadata_dir(&vault_path_string);
        fs::write(metadata.join("notes-assets"), b"not a directory")
            .expect("block attachment storage initialization");

        notes_export_markdown(
            vault_path_string.clone(),
            ROOT_ID.to_string(),
            temp_dir
                .path()
                .join("blocked.md")
                .to_string_lossy()
                .into_owned(),
            false,
        )
        .expect("Markdown export without attachment storage");
        notes_export_pdf(
            vault_path_string,
            ROOT_ID.to_string(),
            temp_dir
                .path()
                .join("blocked.pdf")
                .to_string_lossy()
                .into_owned(),
            false,
        )
        .expect("PDF export without attachment storage");
        assert!(!metadata.join(".notes-assets.lock").exists());
    }

    #[test]
    fn markdown_export_rejects_an_invalid_descendant_without_writing_output() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        let connection = connect_notes_db(&vault_path_string).expect("open export database");
        connection
            .execute(
                "INSERT INTO notes_nodes (\
                   id, parent_id, sort_key, title, note, is_collapsed, completed_at, \
                   created_at, updated_at, deleted_at\
                 ) VALUES (?1, ?2, 3072, 'Injected child', '', 0, NULL, \
                           '2026-07-10T00:00:00.000Z', \
                           '2026-07-10T00:00:00.000Z', NULL)",
                rusqlite::params![INVALID_DESCENDANT_ID, ROOT_ID],
            )
            .expect("corrupt descendant ID");
        drop(connection);
        let destination = temp_dir.path().join("project.md");

        let error = notes_export_markdown(
            vault_path_string,
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            false,
        )
        .expect_err("invalid descendant");

        assert_eq!(error, "Note ID must be a canonical UUID v4 string.");
        assert!(!destination.exists());
    }

    #[test]
    fn markdown_export_fails_before_publish_when_attachment_bytes_are_missing() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        let owned_path = import_export_attachment(
            &temp_dir,
            &vault_path_string,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "missing.png",
        );
        fs::remove_file(&owned_path).expect("remove owned bytes");
        let destination = temp_dir.path().join("missing-export.md");

        let error = notes_export_markdown(
            vault_path_string,
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            false,
        )
        .expect_err("missing attachment must fail export");

        assert!(
            error.contains("Could not open the Notes attachment image"),
            "{error}"
        );
        assert!(!destination.exists());
        assert!(!temp_dir.path().join("missing-export_assets").exists());
    }

    #[test]
    fn notes_export_markdown_preflights_asset_conflict_before_attachment_reads() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        let owned_path = import_export_attachment(
            &temp_dir,
            &vault_path_string,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "must-not-read.png",
        );
        fs::remove_file(owned_path).expect("remove source bytes");
        let destination = temp_dir.path().join("preflight.md");
        let assets = temp_dir.path().join("preflight_assets");
        fs::create_dir(&assets).expect("seed conflicting assets directory");
        fs::write(assets.join("sentinel.txt"), b"untouched").expect("seed sentinel");

        let error = notes_export_markdown(
            vault_path_string,
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            false,
        )
        .expect_err("asset destination conflict");

        assert_eq!(error, "Destination already exists.");
        assert!(!destination.exists());
        assert_eq!(
            fs::read(assets.join("sentinel.txt")).expect("preserved sentinel"),
            b"untouched"
        );
        assert_eq!(fs::read_dir(assets).expect("list assets").count(), 1);
    }

    #[test]
    fn pdf_export_fails_before_publish_when_attachment_bytes_are_missing() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        let owned_path = import_export_attachment(
            &temp_dir,
            &vault_path_string,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "missing-pdf.png",
        );
        fs::remove_file(&owned_path).expect("remove owned bytes");
        let destination = temp_dir.path().join("missing-export.pdf");

        let error = notes_export_pdf(
            vault_path_string,
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            false,
        )
        .expect_err("missing PDF attachment must fail export");

        assert!(
            error.contains("Could not open the Notes attachment image"),
            "{error}"
        );
        assert!(!destination.exists());
    }

    #[test]
    fn notes_export_releases_asset_lease_before_pdf_rendering() {
        use fs4::FileExt;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        import_export_attachment(
            &temp_dir,
            &vault_path_string,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "lease.png",
        );
        let lock_path = crate::metadata_dir(&vault_path_string).join(".notes-assets.lock");

        export_notes_file(
            vault_path_string,
            ROOT_ID.to_string(),
            temp_dir
                .path()
                .join("lease.pdf")
                .to_string_lossy()
                .into_owned(),
            false,
            NotesExportFormat::Pdf,
            |snapshot| {
                let lock = fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&lock_path)
                    .map_err(|error| error.to_string())?;
                FileExt::try_lock(&lock).map_err(|error| {
                    format!("Notes export asset lease remained held during rendering: {error}")
                })?;
                render_pdf(snapshot)
            },
        )
        .expect("render after releasing asset lease");
    }

    #[test]
    fn markdown_export_fails_before_publish_when_attachment_bytes_are_corrupt() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        let owned_path = import_export_attachment(
            &temp_dir,
            &vault_path_string,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "corrupt.png",
        );
        fs::write(&owned_path, b"not an image").expect("corrupt owned bytes");
        let destination = temp_dir.path().join("corrupt-export.md");

        let error = notes_export_markdown(
            vault_path_string,
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            false,
        )
        .expect_err("corrupt attachment must fail export");

        // Reads now SHA-256-verify against the stored content hash instead of
        // re-decoding the image, so corrupt bytes fail the digest check before
        // any assets are published.
        assert!(
            error.contains("no longer matches its stored content hash"),
            "{error}"
        );
        assert!(!destination.exists());
        assert!(!temp_dir.path().join("corrupt-export_assets").exists());
    }

    #[test]
    fn markdown_export_rejects_attachment_path_traversal_before_publish() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        import_export_attachment(
            &temp_dir,
            &vault_path_string,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "safe.png",
        );
        let connection = connect_notes_db(&vault_path_string).expect("open attachment database");
        connection
            .execute(
                "UPDATE notes_attachments SET relative_path = '../outside.png' WHERE id = ?1",
                ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
            )
            .expect("corrupt owned path");
        let destination = temp_dir.path().join("unsafe-export.md");

        let error = notes_export_markdown(
            vault_path_string,
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            false,
        )
        .expect_err("unsafe attachment path must fail export");

        assert_eq!(
            error,
            "A Notes attachment path must be a safe owned relative path."
        );
        assert!(!destination.exists());
        assert!(!temp_dir.path().join("unsafe-export_assets").exists());
    }

    #[cfg(unix)]
    #[test]
    fn export_rejects_an_owned_attachment_file_symlink_without_reading_its_target() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        let owned_path = import_export_attachment(
            &temp_dir,
            &vault_path_string,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "owned.png",
        );
        let outside = temp_dir.path().join("outside.png");
        fs::write(&outside, encoded_png(4, 3)).expect("outside image");
        fs::remove_file(&owned_path).expect("remove owned file");
        symlink(&outside, &owned_path).expect("replace owned file with symlink");
        let destination = temp_dir.path().join("symlink-source.md");

        let error = notes_export_markdown(
            vault_path_string,
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            false,
        )
        .expect_err("owned attachment symlink must fail export");

        assert!(
            error.contains("Could not open the Notes attachment image"),
            "{error}"
        );
        assert!(!destination.exists());
    }

    #[test]
    fn markdown_export_writes_ordered_placements_with_deduplicated_adjacent_assets() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        let first_owned = import_export_attachment(
            &temp_dir,
            &vault_path_string,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "same name.png",
        );
        import_export_attachment(
            &temp_dir,
            &vault_path_string,
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "same name.png",
        );
        let expected_bytes = fs::read(first_owned).expect("read imported attachment");
        let destination = temp_dir.path().join("ordered.md");

        notes_export_markdown(
            vault_path_string,
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            false,
        )
        .expect("export Markdown attachments");

        let markdown = fs::read_to_string(&destination).expect("read Markdown");
        let shared_link = "![same name.png](ordered_assets/0001.png)";
        assert_eq!(markdown.matches(shared_link).count(), 2, "{markdown}");
        assert!(!markdown.contains("ordered_assets/0002.png"), "{markdown}");
        let assets = temp_dir.path().join("ordered_assets");
        assert_eq!(
            fs::read(assets.join("0001.png")).expect("first exported attachment"),
            expected_bytes
        );
        let entries = fs::read_dir(&assets)
            .expect("list assets")
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        // The published directory holds exactly the one deduplicated image plus
        // the export marker (`.yonalist-notes-export.json`) — nothing stray leaks
        // in. Counting only `.png` entries alone would not catch an extra file.
        assert_eq!(
            entries.len(),
            2,
            "assets dir must contain only the shared image and the export marker: {:?}",
            entries.iter().map(|entry| entry.path()).collect::<Vec<_>>()
        );
        let exported_images = entries
            .iter()
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "png"))
            .count();
        assert_eq!(
            exported_images, 1,
            "duplicate placements should share one physical exported asset"
        );
    }

    #[test]
    fn markdown_export_rolls_back_existing_document_and_assets_on_publish_failure() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        import_export_attachment(
            &temp_dir,
            &vault_path_string,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "rollback.png",
        );
        let destination = temp_dir.path().join("rollback.md");
        let assets = temp_dir.path().join("rollback_assets");
        fs::write(&destination, b"old Markdown").expect("seed old Markdown");
        fs::create_dir(&assets).expect("seed old assets");
        fs::write(assets.join("old.png"), b"old attachment").expect("seed old attachment");
        // A real prior export leaves our marker behind; the overwrite guard
        // requires it before it will displace the directory.
        let prior_marker = serde_json::json!({
            "createdBy": crate::notes::export::EXPORT_ASSET_MARKER_CREATED_BY,
            "version": 1,
            "files": ["old.png"],
        });
        fs::write(
            assets.join(crate::notes::export::EXPORT_ASSET_MARKER_NAME),
            serde_json::to_vec(&prior_marker).expect("serialize prior export marker"),
        )
        .expect("seed prior export marker");
        crate::notes::export::inject_markdown_publish_failure_once();

        let error = notes_export_markdown(
            vault_path_string,
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            true,
        )
        .expect_err("injected publish failure");

        assert_eq!(error, "Injected Notes Markdown publish failure.");
        assert_eq!(
            fs::read(&destination).expect("restored Markdown"),
            b"old Markdown"
        );
        assert_eq!(
            fs::read(assets.join("old.png")).expect("restored attachment"),
            b"old attachment"
        );
        // The prior directory is restored intact: its attachment plus its marker,
        // and nothing from the failed export.
        assert!(assets
            .join(crate::notes::export::EXPORT_ASSET_MARKER_NAME)
            .is_file());
        assert_eq!(
            fs::read_dir(&assets).expect("list restored assets").count(),
            2
        );
    }

    #[cfg(unix)]
    #[test]
    fn markdown_export_rejects_an_asset_directory_symlink_without_touching_target() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        import_export_attachment(
            &temp_dir,
            &vault_path_string,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "symlink.png",
        );
        let destination = temp_dir.path().join("symlink.md");
        let outside = temp_dir.path().join("outside");
        fs::create_dir(&outside).expect("outside directory");
        fs::write(outside.join("keep.txt"), b"keep").expect("outside sentinel");
        symlink(&outside, temp_dir.path().join("symlink_assets")).expect("asset symlink");

        let error = notes_export_markdown(
            vault_path_string,
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            true,
        )
        .expect_err("asset symlink must be rejected");

        assert_eq!(error, "Notes export asset directory must not be a symlink.");
        assert!(!destination.exists());
        assert_eq!(
            fs::read(outside.join("keep.txt")).expect("sentinel"),
            b"keep"
        );
    }

    #[test]
    fn pdf_export_conflict_is_reported_before_notes_storage_is_opened() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("existing.pdf");
        std::fs::write(&destination, b"keep me").expect("seed destination");

        let error = notes_export_pdf(
            "   ".to_string(),
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            false,
        )
        .expect_err("occupied destination");

        assert_eq!(error, "Destination already exists.");
        assert_eq!(
            std::fs::read(destination).expect("read destination"),
            b"keep me"
        );
    }

    #[test]
    fn pdf_export_rejects_an_overwrite_directory_before_opening_storage() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("missing-vault");
        let destination = temp_dir.path().join("export.pdf");
        std::fs::create_dir(&destination).expect("seed destination directory");

        let error = notes_export_pdf(
            vault_path.to_string_lossy().into_owned(),
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            true,
        )
        .expect_err("directory destination");

        assert_eq!(error, "File path must name a file.");
        assert!(!vault_path.join(".yonalist").exists());
        assert!(destination.is_dir());
    }

    #[test]
    fn pdf_export_validates_root_and_destination_before_opening_storage() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("missing-vault");
        let destination = temp_dir.path().join("export.pdf");

        let invalid_root = notes_export_pdf(
            vault_path.to_string_lossy().into_owned(),
            "not-a-uuid".to_string(),
            destination.to_string_lossy().into_owned(),
            false,
        )
        .expect_err("invalid root");
        assert_eq!(invalid_root, "Note ID must be a canonical UUID v4 string.");

        let invalid_destination = notes_export_pdf(
            vault_path.to_string_lossy().into_owned(),
            ROOT_ID.to_string(),
            String::new(),
            false,
        )
        .expect_err("invalid destination");
        assert_eq!(invalid_destination, "File path must name a file.");
        assert!(!vault_path.join(".yonalist").exists());
    }

    #[test]
    fn pdf_export_writes_active_snapshot_atomically_without_mutating_source_db() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        let db_path = crate::notes::repository::notes_db_path(&vault_path_string);
        let source_before = std::fs::read(&db_path).expect("read source database before export");
        let destination = temp_dir.path().join("nested/project.pdf");
        let destination_string = destination.to_string_lossy().into_owned();

        let result = notes_export_pdf(
            vault_path_string.clone(),
            ROOT_ID.to_string(),
            destination_string.clone(),
            false,
        )
        .expect("export PDF");

        assert_eq!(result.destination, destination_string);
        assert_eq!(result.format, NotesExportFormat::Pdf);
        let bytes = std::fs::read(&destination).expect("read PDF export");
        let mut warnings = Vec::new();
        let parsed = printpdf::PdfDocument::parse(
            &bytes,
            &printpdf::PdfParseOptions::default(),
            &mut warnings,
        )
        .expect("parse PDF export");
        let text = parsed
            .extract_text()
            .into_iter()
            .flatten()
            .collect::<String>();
        assert!(text.contains("Project"));
        assert!(text.contains("Completed child"));
        assert!(!text.contains("Deleted child"));
        assert_eq!(
            std::fs::read(&db_path).expect("read source database after export"),
            source_before
        );

        std::fs::write(&destination, b"stale").expect("replace with stale destination");
        notes_export_pdf(
            vault_path_string,
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            true,
        )
        .expect("overwrite PDF");
        assert!(std::fs::read(&destination)
            .expect("read overwritten PDF")
            .starts_with(b"%PDF-"));
    }
}
