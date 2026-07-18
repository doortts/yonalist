use crate::notes::attachment_ingest::{
    decode_raw_attachment_envelope, decode_raw_image_node_envelope, ImportAttachmentBytesMetadata,
    ImportImageNodeBytesMetadata, RawAttachmentSource,
};
#[cfg(test)]
use crate::notes::attachments::acquire_attachment_import_permit;
use crate::notes::attachments::{
    acquire_attachment_import_permit_async, AttachmentImportPermit, AttachmentStorageLease,
    PreparedAttachmentBatch, VaultStorageIdentity,
};
use crate::notes::connection::{
    acquire_notes_connection, acquire_vault_app_lock, begin_notes_database_deletion,
    evict_notes_connection, lock_notes_connection, reinitialize_notes_connection,
    try_acquire_existing_vault_app_lock, validate_notes_connection, NotesConnectionGuard,
};
use crate::notes::date_index::{LocalTodayProvider, SystemLocalTodayProvider};
use crate::notes::error::{NotesError, NotesErrorCode};
use crate::notes::export::{
    hydrate_export_attachments, load_export_snapshot, markdown_asset_destination,
    preflight_export_destinations_outside_vault_metadata, preflight_markdown_asset_destination,
    prepare_markdown_export, publish_markdown_export_guarded, render_markdown, render_pdf,
    NotesExportDestinationGuard,
};
#[cfg(test)]
use crate::notes::history::with_untracked_transaction_and_prunes_for_test;
use crate::notes::history::{
    clear_all_history, close_all_history, history_state, history_status, prepare_navigation,
    prune_history_entries, redo_with_attachment_storage_at, require_epoch, reset_history,
    undo_with_attachment_storage_at, validate_context as validate_history_context,
    with_history_transaction_and_prunes,
};
use crate::notes::image_atom::{ack_operation_receipt, lookup_operation_receipt};
use crate::notes::repository::{
    apply_batch_at, archive_node, attachment_by_id, collapse_all,
    create_attachments_coordinated_for_node, create_image_nodes_coordinated, create_node_at,
    delete_database_from_metadata, duplicate_node_at, empty_trash_with_history_reset, expand_all,
    import_subtree_at, list_tags, list_tags_with_counts, load_workspace, move_node,
    note_node_from_audit_json, open_notes_export_db, remove_attachment, remove_empty_node,
    removed_attachment_snapshot, resize_attachment, restore_attachment, restore_node_at,
    search_nodes_at, search_nodes_structured, soft_delete_node, sort_subtree_ascending,
    sort_subtree_descending, split_node_at, toggle_collapsed, toggle_complete, toggle_star,
    unarchive_node, update_node_at, validate_note_tag_filters,
    validate_structured_search_query_input, validate_vault_path, NewAttachment, NewImageNode,
    SORT_KEY_STEP,
};
#[cfg(test)]
use crate::notes::types::NotesHistoryReplayResult;
use crate::notes::types::{
    validate_image_node_batch_fields, validate_note_id, ApplyBatchInput, CreateNodeInput,
    ImageAtomOperationLookup, ImportAttachmentInput, ImportAttachmentPathBatchInput,
    ImportImageNodePathsInput, ImportSubtreeInput, MoveNodeInput, NoteAttachment, NoteNode,
    NoteSearchResult, NoteSearchScope, NoteStructuredSearchQuery, NoteTagSummary,
    NotesExportFormat, NotesExportResult, NotesExportSnapshot, NotesHistoryCloseInput,
    NotesHistoryContext, NotesHistoryReplayOutcome, NotesHistoryReplayRequest,
    NotesHistoryResetInput, NotesHistoryResetResult, NotesHistoryState, NotesHistoryStatus,
    NotesInitializeInput, NotesMutationResult, NotesPrepareNavigationInput, NotesPruneHistoryInput,
    NotesWorkspace, NotesWorkspaceScope, ResizeAttachmentInput, SplitNodeInput, UpdateNodeInput,
};
use cap_fs_ext::{
    DirExt, FollowSymlinks, MetadataExt as CapabilityMetadataExt, OpenOptionsFollowExt,
};
use cap_std::ambient_authority;
#[cfg(not(windows))]
use cap_std::fs::DirBuilder;
use cap_std::fs::{Dir, OpenOptions, Permissions};
#[cfg(unix)]
use cap_std::fs::{
    DirBuilderExt as CapDirBuilderExt, MetadataExt as CapUnixMetadataExt,
    OpenOptionsExt as CapOpenOptionsExt, PermissionsExt as CapPermissionsExt,
};
use rusqlite::OptionalExtension;
use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

enum MutationHistory {
    Tracked(NotesHistoryContext),
    #[cfg(test)]
    UntrackedForTest,
}

impl MutationHistory {
    fn context(&self) -> Option<&NotesHistoryContext> {
        match self {
            Self::Tracked(context) => Some(context),
            #[cfg(test)]
            Self::UntrackedForTest => None,
        }
    }
}

#[cfg(test)]
fn mutation_history_for_test(context: Option<NotesHistoryContext>) -> MutationHistory {
    match context {
        Some(context) => MutationHistory::Tracked(context),
        None => MutationHistory::UntrackedForTest,
    }
}

// Tests exercise schema initialization directly through owned
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

fn acquire_existing_vault_app_lock(vault_path: &str) -> Result<(), String> {
    try_acquire_existing_vault_app_lock(vault_path).map(drop)
}

#[cfg(test)]
type RawImportPermitTestTask = Box<dyn FnOnce() + Send + 'static>;

#[cfg(test)]
#[derive(Clone)]
struct RawImportPermitTestDispatch {
    tasks: std::sync::mpsc::Sender<RawImportPermitTestTask>,
    requests: std::sync::mpsc::Sender<()>,
}

#[cfg(test)]
static RAW_IMPORT_PERMIT_TEST_DISPATCH: std::sync::Mutex<Option<RawImportPermitTestDispatch>> =
    std::sync::Mutex::new(None);

async fn acquire_import_permit_for_command() -> Result<AttachmentImportPermit, NotesError> {
    #[cfg(test)]
    {
        let dispatch = RAW_IMPORT_PERMIT_TEST_DISPATCH
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some(dispatch) = dispatch {
            dispatch.requests.send(()).map_err(|_| {
                NotesError::new(
                    NotesErrorCode::Internal,
                    "The Notes test admission observer is unavailable.",
                )
            })?;
        }
    }

    acquire_attachment_import_permit_async()
        .await
        .map_err(NotesError::from)
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttachmentBatchFault {
    ReturnAfterPublished(usize),
    ReturnBeforeCommit,
    CrashAfterPublished(usize),
    CrashBeforeCommit,
}

#[cfg(test)]
thread_local! {
    static ATTACHMENT_BATCH_FAULT: std::cell::Cell<Option<AttachmentBatchFault>> = const { std::cell::Cell::new(None) };
    static ATTACHMENT_BATCH_CRASH_INTERRUPTED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static ATTACHMENT_BATCH_PERFORMANCE_PROBE: std::cell::RefCell<Option<AttachmentBatchPerformanceProbeState>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
thread_local! {
    static ATTACHMENT_BEFORE_DATABASE_IDENTITY_CAPTURE: std::cell::RefCell<
        Option<Box<dyn FnOnce()>>,
    > = const { std::cell::RefCell::new(None) };
    static IMAGE_NODE_RETRY_BEFORE_RETURN: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn inject_attachment_before_database_identity_capture_once(action: impl FnOnce() + 'static) {
    ATTACHMENT_BEFORE_DATABASE_IDENTITY_CAPTURE
        .with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

fn maybe_inject_attachment_before_database_identity_capture() {
    #[cfg(test)]
    if let Some(action) =
        ATTACHMENT_BEFORE_DATABASE_IDENTITY_CAPTURE.with(|slot| slot.borrow_mut().take())
    {
        action();
    }
}

#[cfg(test)]
fn inject_image_node_retry_before_return_once(action: impl FnOnce() + 'static) {
    IMAGE_NODE_RETRY_BEFORE_RETURN.with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

fn maybe_inject_image_node_retry_before_return() {
    #[cfg(test)]
    if let Some(action) = IMAGE_NODE_RETRY_BEFORE_RETURN.with(|slot| slot.borrow_mut().take()) {
        action();
    }
}

#[cfg(test)]
thread_local! {
    static EXPORT_BEFORE_PUBLICATION_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static EXPORT_AFTER_FINAL_REVALIDATION_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn inject_export_before_publication_once(action: impl FnOnce() + 'static) {
    EXPORT_BEFORE_PUBLICATION_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

fn maybe_inject_export_before_publication() {
    #[cfg(test)]
    if let Some(action) = EXPORT_BEFORE_PUBLICATION_HOOK.with(|slot| slot.borrow_mut().take()) {
        action();
    }
}

#[cfg(test)]
fn inject_export_after_final_revalidation_once(action: impl FnOnce() + 'static) {
    EXPORT_AFTER_FINAL_REVALIDATION_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

fn maybe_inject_export_after_final_revalidation() {
    #[cfg(test)]
    if let Some(action) = EXPORT_AFTER_FINAL_REVALIDATION_HOOK.with(|slot| slot.borrow_mut().take())
    {
        action();
    }
}

#[cfg(test)]
#[derive(Debug, Clone, Default)]
struct AttachmentBatchPerformanceSamples {
    prepare: Vec<std::time::Duration>,
    publish: Vec<std::time::Duration>,
    commit: Vec<std::time::Duration>,
    commit_wrapper_returns: usize,
}

#[cfg(test)]
#[derive(Debug, Default)]
struct AttachmentBatchPerformanceProbeState {
    samples: AttachmentBatchPerformanceSamples,
    commit_started: Option<std::time::Instant>,
    history_wrapper_returned: bool,
}

#[cfg(test)]
struct AttachmentBatchPerformanceProbeGuard;

#[cfg(test)]
impl AttachmentBatchPerformanceProbeGuard {
    fn enable() -> Self {
        ATTACHMENT_BATCH_PERFORMANCE_PROBE.with(|probe| {
            let mut probe = probe.borrow_mut();
            assert!(probe.is_none(), "attachment batch performance probe leaked");
            *probe = Some(AttachmentBatchPerformanceProbeState::default());
        });
        Self
    }

    fn samples(&self) -> AttachmentBatchPerformanceSamples {
        ATTACHMENT_BATCH_PERFORMANCE_PROBE.with(|probe| {
            probe
                .borrow()
                .as_ref()
                .expect("attachment batch performance probe is active")
                .samples
                .clone()
        })
    }

    fn commit_is_pending(&self) -> bool {
        ATTACHMENT_BATCH_PERFORMANCE_PROBE.with(|probe| {
            probe
                .borrow()
                .as_ref()
                .expect("attachment batch performance probe is active")
                .commit_started
                .is_some()
        })
    }
}

#[cfg(test)]
impl Drop for AttachmentBatchPerformanceProbeGuard {
    fn drop(&mut self) {
        ATTACHMENT_BATCH_PERFORMANCE_PROBE.with(|probe| {
            *probe.borrow_mut() = None;
        });
    }
}

#[cfg(test)]
fn attachment_batch_performance_probe_is_active() -> bool {
    ATTACHMENT_BATCH_PERFORMANCE_PROBE.with(|probe| probe.borrow().is_some())
}

#[cfg(test)]
#[derive(Debug, Clone, Copy)]
enum AttachmentBatchPerformanceStage {
    Prepare,
    Publish,
}

#[cfg(test)]
struct AttachmentBatchPerformanceStageTimer {
    stage: AttachmentBatchPerformanceStage,
    started: Option<std::time::Instant>,
}

#[cfg(test)]
impl AttachmentBatchPerformanceStageTimer {
    fn start(stage: AttachmentBatchPerformanceStage) -> Self {
        let started = attachment_batch_performance_probe_is_active().then(std::time::Instant::now);
        Self { stage, started }
    }
}

#[cfg(test)]
impl Drop for AttachmentBatchPerformanceStageTimer {
    fn drop(&mut self) {
        let Some(started) = self.started else {
            return;
        };
        ATTACHMENT_BATCH_PERFORMANCE_PROBE.with(|probe| {
            let mut probe = probe.borrow_mut();
            let Some(probe) = probe.as_mut() else {
                return;
            };
            let elapsed = started.elapsed();
            match self.stage {
                AttachmentBatchPerformanceStage::Prepare => probe.samples.prepare.push(elapsed),
                AttachmentBatchPerformanceStage::Publish => probe.samples.publish.push(elapsed),
            }
        });
    }
}

#[cfg(test)]
fn start_attachment_batch_commit_stage() {
    ATTACHMENT_BATCH_PERFORMANCE_PROBE.with(|probe| {
        let mut probe = probe.borrow_mut();
        let Some(probe) = probe.as_mut() else {
            return;
        };
        assert!(
            probe.commit_started.is_none(),
            "attachment batch commit stage was started more than once"
        );
        probe.history_wrapper_returned = false;
        probe.commit_started = Some(std::time::Instant::now());
    })
}

#[cfg(test)]
fn mark_attachment_batch_history_wrapper_returned() {
    ATTACHMENT_BATCH_PERFORMANCE_PROBE.with(|probe| {
        let mut probe = probe.borrow_mut();
        let Some(probe) = probe.as_mut() else {
            return;
        };
        if probe.commit_started.is_none() {
            return;
        }
        assert!(
            !probe.history_wrapper_returned,
            "attachment batch history wrapper return was recorded more than once"
        );
        probe.history_wrapper_returned = true;
        probe.samples.commit_wrapper_returns += 1;
    });
}

#[cfg(test)]
fn finish_attachment_batch_commit_stage(succeeded: bool) -> Result<(), &'static str> {
    ATTACHMENT_BATCH_PERFORMANCE_PROBE.with(|probe| {
        let mut probe = probe.borrow_mut();
        let Some(probe) = probe.as_mut() else {
            return Ok(());
        };
        let started = probe.commit_started.take();
        let history_wrapper_returned = std::mem::take(&mut probe.history_wrapper_returned);
        if succeeded {
            if !history_wrapper_returned {
                return Err(
                    "successful attachment batch commit timing must finish after the history wrapper returns",
                );
            }
            let started = started
                .ok_or("successful attachment batch commit stage must have started")?;
            probe.samples.commit.push(started.elapsed());
        }
        Ok(())
    })
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
        == Some(AttachmentBatchFault::ReturnBeforeCommit)
    {
        ATTACHMENT_BATCH_FAULT.with(|current| current.set(None));
        return Err("injected attachment batch transaction failure".to_string());
    }
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
#[derive(Clone, Debug, PartialEq, Eq)]
enum AttachmentViewCopyRemoveFault {
    PermissionDeniedIfReadonly,
    PermissionDeniedForName(OsString),
    PermissionDeniedForAll,
    PermissionDeniedAfterReadonlyClearForName(OsString),
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
enum AttachmentViewCopyOpenValidationFault {
    ReplaceRoot { moved_root: PathBuf },
    ReplaceCopyWithFile,
    HardlinkCopy { link_path: PathBuf },
}

#[cfg(test)]
thread_local! {
    static ATTACHMENT_VIEW_COPY_REMOVE_FAULT: std::cell::RefCell<
        Option<AttachmentViewCopyRemoveFault>,
    > = const { std::cell::RefCell::new(None) };
    static ATTACHMENT_VIEW_COPY_OPEN_VALIDATION_FAULT: std::cell::RefCell<
        Option<AttachmentViewCopyOpenValidationFault>,
    > = const { std::cell::RefCell::new(None) };
    static ATTACHMENT_DOWNLOAD_BEFORE_EXISTING_PUBLICATION_HOOK: std::cell::RefCell<
        Option<Box<dyn FnOnce() -> Result<(), String>>>,
    > = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
struct AttachmentViewCopyRemoveFaultGuard;

#[cfg(test)]
impl AttachmentViewCopyRemoveFaultGuard {
    fn enable(fault: AttachmentViewCopyRemoveFault) -> Self {
        ATTACHMENT_VIEW_COPY_REMOVE_FAULT.with(|slot| {
            let mut slot = slot.borrow_mut();
            assert!(slot.is_none(), "attachment view-copy remove fault leaked");
            *slot = Some(fault);
        });
        Self
    }
}

#[cfg(test)]
impl Drop for AttachmentViewCopyRemoveFaultGuard {
    fn drop(&mut self) {
        ATTACHMENT_VIEW_COPY_REMOVE_FAULT.with(|slot| *slot.borrow_mut() = None);
    }
}

#[cfg(test)]
struct AttachmentViewCopyOpenValidationFaultGuard;

#[cfg(test)]
impl AttachmentViewCopyOpenValidationFaultGuard {
    fn enable(fault: AttachmentViewCopyOpenValidationFault) -> Self {
        ATTACHMENT_VIEW_COPY_OPEN_VALIDATION_FAULT.with(|slot| {
            let mut slot = slot.borrow_mut();
            assert!(
                slot.is_none(),
                "attachment view-copy open validation fault leaked"
            );
            *slot = Some(fault);
        });
        Self
    }
}

#[cfg(test)]
impl Drop for AttachmentViewCopyOpenValidationFaultGuard {
    fn drop(&mut self) {
        ATTACHMENT_VIEW_COPY_OPEN_VALIDATION_FAULT.with(|slot| *slot.borrow_mut() = None);
    }
}

#[cfg(test)]
struct AttachmentDownloadBeforeExistingPublicationHookGuard;

#[cfg(test)]
impl AttachmentDownloadBeforeExistingPublicationHookGuard {
    fn enable(hook: impl FnOnce() -> Result<(), String> + 'static) -> Self {
        ATTACHMENT_DOWNLOAD_BEFORE_EXISTING_PUBLICATION_HOOK.with(|slot| {
            let mut slot = slot.borrow_mut();
            assert!(
                slot.is_none(),
                "attachment download publication hook leaked"
            );
            *slot = Some(Box::new(hook));
        });
        Self
    }
}

#[cfg(test)]
impl Drop for AttachmentDownloadBeforeExistingPublicationHookGuard {
    fn drop(&mut self) {
        ATTACHMENT_DOWNLOAD_BEFORE_EXISTING_PUBLICATION_HOOK.with(|slot| *slot.borrow_mut() = None);
    }
}

fn maybe_inject_attachment_download_before_existing_publication() -> Result<(), String> {
    #[cfg(test)]
    if let Some(hook) =
        ATTACHMENT_DOWNLOAD_BEFORE_EXISTING_PUBLICATION_HOOK.with(|slot| slot.borrow_mut().take())
    {
        hook()?;
    }
    Ok(())
}

#[cfg(test)]
fn arm_delete_database_race() {
    DELETE_DATABASE_RACED_CONNECTION.with(|slot| *slot.borrow_mut() = None);
    DELETE_DATABASE_RACE_ARMED.with(|armed| armed.set(true));
}

#[cfg(test)]
fn take_delete_database_raced_connection() -> Option<crate::notes::connection::SharedNotesConnection>
{
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
pub(crate) async fn notes_initialize(
    vault_path: String,
    input: NotesInitializeInput,
) -> Result<NotesHistoryState, NotesError> {
    run_blocking(move || notes_initialize_for_session_inner(vault_path, input)).await
}

pub(crate) fn notes_initialize_inner(vault_path: String) -> Result<(), String> {
    validate_vault_path(&vault_path)?;
    // After side-effect-free validation, take the process-wide vault lock before
    // storage initialization so a second window is rejected up front (with a
    // clear message) rather than after waiting on the attachment lease. Holding
    // it for the connection manager's lifetime is what stops a second instance's
    // `clear_all_history` below from destroying this instance's undo history.
    // Reentrant within one process.
    drop(acquire_vault_app_lock(&vault_path)?);
    let storage = AttachmentStorageLease::acquire(&vault_path)?;
    // Opening a vault must run schema initialization exactly once, so
    // force a fresh connection here even if an earlier command already cached
    // one. Every subsequent command reuses this initialized connection.
    let shared = reinitialize_notes_connection(&vault_path)?;
    let mut connection = lock_notes_connection(&shared)?;
    clear_all_history(&mut connection)?;
    validate_notes_connection(&connection)?;
    reconcile_after_committed_attachment_change(&storage, &connection);
    validate_notes_connection(&connection)?;
    Ok(())
}

pub(crate) fn notes_initialize_for_session_inner(
    vault_path: String,
    input: NotesInitializeInput,
) -> Result<NotesHistoryState, String> {
    notes_initialize_inner(vault_path.clone())?;
    let shared = acquire_notes_connection(&vault_path)?;
    let connection = lock_notes_connection(&shared)?;
    history_state(&connection, &input.session_id, Vec::new())
}

fn run_mutation(
    vault_path: &str,
    history_context: NotesHistoryContext,
    operation: impl FnOnce(&mut rusqlite::Connection) -> Result<NotesWorkspace, String>,
) -> Result<NotesMutationResult, String> {
    let storage = AttachmentStorageLease::acquire(vault_path)?;
    let shared = acquire_notes_connection(vault_path)?;
    let mut connection = lock_notes_connection(&shared)?;
    let result =
        with_history_transaction_and_prunes(&mut connection, Some(&history_context), operation)?;
    validate_notes_connection(&connection)?;
    reconcile_candidates_after_committed_change(
        &storage,
        &connection,
        &result.pruned_attachment_paths,
    );
    validate_notes_connection(&connection)?;
    Ok(result.into_mutation_result())
}

fn run_dated_mutation(
    vault_path: &str,
    history_context: NotesHistoryContext,
    today_provider: &impl LocalTodayProvider,
    operation: impl FnOnce(
        &mut rusqlite::Connection,
        crate::notes::date_index::LocalDate,
    ) -> Result<NotesWorkspace, String>,
) -> Result<NotesMutationResult, String> {
    let storage = AttachmentStorageLease::acquire(vault_path)?;
    let shared = acquire_notes_connection(vault_path)?;
    let mut connection = lock_notes_connection(&shared)?;
    let today = today_provider.local_today(&connection)?;
    let result = with_history_transaction_and_prunes(
        &mut connection,
        Some(&history_context),
        |connection| operation(connection, today),
    )?;
    validate_notes_connection(&connection)?;
    reconcile_candidates_after_committed_change(
        &storage,
        &connection,
        &result.pruned_attachment_paths,
    );
    validate_notes_connection(&connection)?;
    Ok(result.into_mutation_result())
}

#[cfg(test)]
fn run_mutation_with_optional_history_context_for_test(
    vault_path: &str,
    history_context: Option<NotesHistoryContext>,
    operation: impl FnOnce(&mut rusqlite::Connection) -> Result<NotesWorkspace, String>,
) -> Result<NotesMutationResult, String> {
    let Some(history_context) = history_context else {
        let storage = AttachmentStorageLease::acquire(vault_path)?;
        let shared = acquire_notes_connection(vault_path)?;
        let mut connection = lock_notes_connection(&shared)?;
        let result = with_untracked_transaction_and_prunes_for_test(&mut connection, operation)?;
        validate_notes_connection(&connection)?;
        reconcile_candidates_after_committed_change(
            &storage,
            &connection,
            &result.pruned_attachment_paths,
        );
        validate_notes_connection(&connection)?;
        return Ok(result.into_mutation_result());
    };
    run_mutation(vault_path, history_context, operation)
}

#[cfg(test)]
fn run_dated_mutation_with_optional_history_context_for_test(
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
    let mut connection = lock_notes_connection(&shared)?;
    let today = today_provider.local_today(&connection)?;
    let result = match history_context.as_ref() {
        Some(context) => {
            with_history_transaction_and_prunes(&mut connection, Some(context), |connection| {
                operation(connection, today)
            })?
        }
        None => with_untracked_transaction_and_prunes_for_test(&mut connection, |connection| {
            operation(connection, today)
        })?,
    };
    validate_notes_connection(&connection)?;
    reconcile_candidates_after_committed_change(
        &storage,
        &connection,
        &result.pruned_attachment_paths,
    );
    validate_notes_connection(&connection)?;
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
    let connection = lock_notes_connection(&shared)?;
    load_workspace(&connection, scope)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_create_node(
    vault_path: String,
    input: CreateNodeInput,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_create_node_inner(vault_path, input, history_context)).await
}

pub(crate) fn notes_create_node_inner(
    vault_path: String,
    input: CreateNodeInput,
    history_context: NotesHistoryContext,
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
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_update_node_inner(vault_path, input, history_context)).await
}

pub(crate) fn notes_update_node_inner(
    vault_path: String,
    input: UpdateNodeInput,
    history_context: NotesHistoryContext,
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
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_split_node_inner(vault_path, input, history_context)).await
}

pub(crate) fn notes_split_node_inner(
    vault_path: String,
    input: SplitNodeInput,
    history_context: NotesHistoryContext,
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
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_move_node_inner(vault_path, input, history_context)).await
}

pub(crate) fn notes_move_node_inner(
    vault_path: String,
    input: MoveNodeInput,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        move_node(connection, input)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_apply_batch(
    vault_path: String,
    input: ApplyBatchInput,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_apply_batch_inner(vault_path, input, history_context)).await
}

pub(crate) fn notes_apply_batch_inner(
    vault_path: String,
    input: ApplyBatchInput,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, String> {
    // Duplicate and tag batches can write title/note content, so every batch
    // runs through one dated path. Only duplicate returns copied root ids.
    let mut duplicated_root_ids = None;
    let mut result = run_dated_mutation(
        &vault_path,
        history_context,
        &SystemLocalTodayProvider,
        |connection, today| {
            let (workspace, root_ids) = apply_batch_at(connection, input, today)?;
            duplicated_root_ids = root_ids;
            Ok(workspace)
        },
    )?;
    result.duplicated_root_ids = duplicated_root_ids;
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_import_subtree(
    vault_path: String,
    input: ImportSubtreeInput,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_import_subtree_inner(vault_path, input, history_context)).await
}

pub(crate) fn notes_import_subtree_inner(
    vault_path: String,
    input: ImportSubtreeInput,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, String> {
    // Imported content may carry dates/tags, so run through the dated path so
    // the derived-content rebuild resolves relative phrases against `today`
    // (like `create_node`). `import_subtree_at` generates the root ids inside
    // the same transaction; capture them so the result can tell the frontend
    // which nodes to focus. Every mutation here still produces exactly ONE
    // history entry via `with_workspace_transaction`.
    let mut imported_root_ids: Vec<crate::notes::types::NoteId> = Vec::new();
    let mut result = run_dated_mutation(
        &vault_path,
        history_context,
        &SystemLocalTodayProvider,
        |connection, today| {
            let (workspace, root_ids) = import_subtree_at(connection, input, today)?;
            imported_root_ids = root_ids;
            Ok(workspace)
        },
    )?;
    result.imported_root_ids = Some(imported_root_ids);
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_toggle_complete(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_toggle_complete_inner(vault_path, node_id, history_context)).await
}

pub(crate) fn notes_toggle_complete_inner(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        toggle_complete(connection, &node_id)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_toggle_collapsed(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_toggle_collapsed_inner(vault_path, node_id, history_context)).await
}

pub(crate) fn notes_toggle_collapsed_inner(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        toggle_collapsed(connection, &node_id)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_collapse_all(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_collapse_all_inner(vault_path, node_id, history_context)).await
}

pub(crate) fn notes_collapse_all_inner(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        collapse_all(connection, &node_id)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_expand_all(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_expand_all_inner(vault_path, node_id, history_context)).await
}

pub(crate) fn notes_expand_all_inner(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        expand_all(connection, &node_id)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_sort_subtree_ascending(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_sort_subtree_ascending_inner(vault_path, node_id, history_context))
        .await
}

pub(crate) fn notes_sort_subtree_ascending_inner(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        sort_subtree_ascending(connection, &node_id)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_sort_subtree_descending(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_sort_subtree_descending_inner(vault_path, node_id, history_context))
        .await
}

pub(crate) fn notes_sort_subtree_descending_inner(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        sort_subtree_descending(connection, &node_id)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_toggle_star(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_toggle_star_inner(vault_path, node_id, history_context)).await
}

pub(crate) fn notes_toggle_star_inner(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        toggle_star(connection, &node_id)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_duplicate_node(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_duplicate_node_inner(vault_path, node_id, history_context)).await
}

pub(crate) fn notes_duplicate_node_inner(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
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
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_remove_empty_node_inner(vault_path, node_id, history_context)).await
}

pub(crate) fn notes_remove_empty_node_inner(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        remove_empty_node(connection, &node_id)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_soft_delete_node(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_soft_delete_node_inner(vault_path, node_id, history_context)).await
}

pub(crate) fn notes_soft_delete_node_inner(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        soft_delete_node(connection, &node_id)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_restore_node(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_restore_node_inner(vault_path, node_id, history_context)).await
}

pub(crate) fn notes_restore_node_inner(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
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
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_archive_node_inner(vault_path, node_id, history_context)).await
}

pub(crate) fn notes_archive_node_inner(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        archive_node(connection, &node_id)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_unarchive_node(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_unarchive_node_inner(vault_path, node_id, history_context)).await
}

pub(crate) fn notes_unarchive_node_inner(
    vault_path: String,
    node_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        unarchive_node(connection, &node_id)
    })
}

#[cfg(test)]
pub(crate) fn notes_create_node_with_optional_history_context_for_test(
    vault_path: String,
    input: CreateNodeInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_dated_mutation_with_optional_history_context_for_test(
        &vault_path,
        history_context,
        &SystemLocalTodayProvider,
        |connection, today| create_node_at(connection, input, today),
    )
}

#[cfg(test)]
pub(crate) fn notes_update_node_with_optional_history_context_for_test(
    vault_path: String,
    input: UpdateNodeInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_dated_mutation_with_optional_history_context_for_test(
        &vault_path,
        history_context,
        &SystemLocalTodayProvider,
        |connection, today| update_node_at(connection, input, today),
    )
}

#[cfg(test)]
pub(crate) fn notes_split_node_with_optional_history_context_for_test(
    vault_path: String,
    input: SplitNodeInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_dated_mutation_with_optional_history_context_for_test(
        &vault_path,
        history_context,
        &SystemLocalTodayProvider,
        |connection, today| split_node_at(connection, input, today),
    )
}

#[cfg(test)]
pub(crate) fn notes_move_node_with_optional_history_context_for_test(
    vault_path: String,
    input: MoveNodeInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_mutation_with_optional_history_context_for_test(
        &vault_path,
        history_context,
        |connection| move_node(connection, input),
    )
}

#[cfg(test)]
pub(crate) fn notes_apply_batch_with_optional_history_context_for_test(
    vault_path: String,
    input: ApplyBatchInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    let mut duplicated_root_ids = None;
    let mut result = run_dated_mutation_with_optional_history_context_for_test(
        &vault_path,
        history_context,
        &SystemLocalTodayProvider,
        |connection, today| {
            let (workspace, root_ids) = apply_batch_at(connection, input, today)?;
            duplicated_root_ids = root_ids;
            Ok(workspace)
        },
    )?;
    result.duplicated_root_ids = duplicated_root_ids;
    Ok(result)
}

macro_rules! optional_node_history_test_helper {
    ($name:ident, $operation:ident) => {
        #[cfg(test)]
        pub(crate) fn $name(
            vault_path: String,
            node_id: String,
            history_context: Option<NotesHistoryContext>,
        ) -> Result<NotesMutationResult, String> {
            run_mutation_with_optional_history_context_for_test(
                &vault_path,
                history_context,
                |connection| $operation(connection, &node_id),
            )
        }
    };
}

optional_node_history_test_helper!(
    notes_toggle_complete_with_optional_history_context_for_test,
    toggle_complete
);
optional_node_history_test_helper!(
    notes_toggle_collapsed_with_optional_history_context_for_test,
    toggle_collapsed
);
optional_node_history_test_helper!(
    notes_collapse_all_with_optional_history_context_for_test,
    collapse_all
);
optional_node_history_test_helper!(
    notes_expand_all_with_optional_history_context_for_test,
    expand_all
);
optional_node_history_test_helper!(
    notes_sort_subtree_ascending_with_optional_history_context_for_test,
    sort_subtree_ascending
);
optional_node_history_test_helper!(
    notes_sort_subtree_descending_with_optional_history_context_for_test,
    sort_subtree_descending
);
optional_node_history_test_helper!(
    notes_toggle_star_with_optional_history_context_for_test,
    toggle_star
);
optional_node_history_test_helper!(
    notes_remove_empty_node_with_optional_history_context_for_test,
    remove_empty_node
);
optional_node_history_test_helper!(
    notes_soft_delete_node_with_optional_history_context_for_test,
    soft_delete_node
);
optional_node_history_test_helper!(
    notes_archive_node_with_optional_history_context_for_test,
    archive_node
);
optional_node_history_test_helper!(
    notes_unarchive_node_with_optional_history_context_for_test,
    unarchive_node
);

#[cfg(test)]
pub(crate) fn notes_duplicate_node_with_optional_history_context_for_test(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_dated_mutation_with_optional_history_context_for_test(
        &vault_path,
        history_context,
        &SystemLocalTodayProvider,
        |connection, today| duplicate_node_at(connection, &node_id, today),
    )
}

#[cfg(test)]
pub(crate) fn notes_restore_node_with_optional_history_context_for_test(
    vault_path: String,
    node_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_dated_mutation_with_optional_history_context_for_test(
        &vault_path,
        history_context,
        &SystemLocalTodayProvider,
        |connection, today| restore_node_at(connection, &node_id, today),
    )
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_undo(
    vault_path: String,
    request: NotesHistoryReplayRequest,
) -> Result<NotesHistoryReplayOutcome, NotesError> {
    run_blocking(move || notes_undo_expected_inner(vault_path, request)).await
}

pub(crate) fn notes_undo_expected_inner(
    vault_path: String,
    request: NotesHistoryReplayRequest,
) -> Result<NotesHistoryReplayOutcome, String> {
    notes_undo_with_provider(vault_path, request, &SystemLocalTodayProvider)
}

fn notes_undo_with_provider(
    vault_path: String,
    request: NotesHistoryReplayRequest,
    today_provider: &impl LocalTodayProvider,
) -> Result<NotesHistoryReplayOutcome, String> {
    let storage = AttachmentStorageLease::acquire(&vault_path)?;
    let shared = acquire_notes_connection(&vault_path)?;
    let mut connection = lock_notes_connection(&shared)?;
    let today = today_provider.local_today(&connection)?;
    let result = undo_with_attachment_storage_at(
        &mut connection,
        &request.session_id,
        &request.history_epoch,
        &request.expected_entry_id,
        request.scope,
        &storage,
        today,
    )?;
    validate_notes_connection(&connection)?;
    reconcile_after_committed_attachment_change(&storage, &connection);
    validate_notes_connection(&connection)?;
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_redo(
    vault_path: String,
    request: NotesHistoryReplayRequest,
) -> Result<NotesHistoryReplayOutcome, NotesError> {
    run_blocking(move || notes_redo_expected_inner(vault_path, request)).await
}

pub(crate) fn notes_redo_expected_inner(
    vault_path: String,
    request: NotesHistoryReplayRequest,
) -> Result<NotesHistoryReplayOutcome, String> {
    notes_redo_with_provider(vault_path, request, &SystemLocalTodayProvider)
}

fn notes_redo_with_provider(
    vault_path: String,
    request: NotesHistoryReplayRequest,
    today_provider: &impl LocalTodayProvider,
) -> Result<NotesHistoryReplayOutcome, String> {
    let storage = AttachmentStorageLease::acquire(&vault_path)?;
    let shared = acquire_notes_connection(&vault_path)?;
    let mut connection = lock_notes_connection(&shared)?;
    let today = today_provider.local_today(&connection)?;
    let result = redo_with_attachment_storage_at(
        &mut connection,
        &request.session_id,
        &request.history_epoch,
        &request.expected_entry_id,
        request.scope,
        &storage,
        today,
    )?;
    validate_notes_connection(&connection)?;
    reconcile_after_committed_attachment_change(&storage, &connection);
    validate_notes_connection(&connection)?;
    Ok(result)
}

#[cfg(test)]
fn legacy_replay_result(
    vault_path: String,
    session_id: String,
    scope: NotesWorkspaceScope,
    undoing: bool,
) -> Result<NotesHistoryReplayResult, String> {
    let state = notes_history_status_inner(vault_path.clone(), session_id.clone())?;
    let expected_entry_id = if undoing {
        state.next_undo_entry_id.clone()
    } else {
        state.next_redo_entry_id.clone()
    };
    let Some(expected_entry_id) = expected_entry_id else {
        return Ok(NotesHistoryReplayResult {
            workspace: notes_load_workspace_inner(vault_path, scope)?,
            replayed_entry_id: None,
            state,
        });
    };
    let request = NotesHistoryReplayRequest {
        session_id,
        history_epoch: state.history_epoch,
        expected_entry_id,
        scope,
    };
    let outcome = if undoing {
        notes_undo_expected_inner(vault_path, request)?
    } else {
        notes_redo_expected_inner(vault_path, request)?
    };
    match outcome {
        NotesHistoryReplayOutcome::Applied {
            workspace,
            replayed_entry_id,
            state,
        } => Ok(NotesHistoryReplayResult {
            workspace,
            replayed_entry_id: Some(replayed_entry_id),
            state,
        }),
        _ => Err("Legacy Notes history replay was unexpectedly rejected.".to_string()),
    }
}

#[cfg(test)]
pub(crate) fn notes_undo_legacy_inner(
    vault_path: String,
    session_id: String,
    scope: NotesWorkspaceScope,
) -> Result<NotesHistoryReplayResult, String> {
    legacy_replay_result(vault_path, session_id, scope, true)
}

#[cfg(test)]
pub(crate) fn notes_redo_legacy_inner(
    vault_path: String,
    session_id: String,
    scope: NotesWorkspaceScope,
) -> Result<NotesHistoryReplayResult, String> {
    legacy_replay_result(vault_path, session_id, scope, false)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_history_status(
    vault_path: String,
    session_id: String,
) -> Result<NotesHistoryState, NotesError> {
    run_blocking(move || notes_history_status_inner(vault_path, session_id)).await
}

pub(crate) fn notes_history_status_inner(
    vault_path: String,
    session_id: String,
) -> Result<NotesHistoryState, String> {
    let shared = acquire_notes_connection(&vault_path)?;
    let connection = lock_notes_connection(&shared)?;
    history_status(&connection, &session_id)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_lookup_image_atom_operation(
    vault_path: String,
    session_id: String,
    history_epoch: String,
    operation_id: String,
) -> Result<ImageAtomOperationLookup, NotesError> {
    run_blocking(move || {
        notes_lookup_image_atom_operation_inner(vault_path, session_id, history_epoch, operation_id)
    })
    .await
}

pub(crate) fn notes_lookup_image_atom_operation_inner(
    vault_path: String,
    session_id: String,
    history_epoch: String,
    operation_id: String,
) -> Result<ImageAtomOperationLookup, String> {
    let shared = acquire_notes_connection(&vault_path)?;
    let connection = lock_notes_connection(&shared)?;
    lookup_operation_receipt(&connection, &session_id, &history_epoch, &operation_id)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_ack_image_atom_operation(
    vault_path: String,
    session_id: String,
    history_epoch: String,
    operation_id: String,
) -> Result<(), NotesError> {
    run_blocking(move || {
        notes_ack_image_atom_operation_inner(vault_path, session_id, history_epoch, operation_id)
    })
    .await
}

pub(crate) fn notes_ack_image_atom_operation_inner(
    vault_path: String,
    session_id: String,
    history_epoch: String,
    operation_id: String,
) -> Result<(), String> {
    let shared = acquire_notes_connection(&vault_path)?;
    let connection = lock_notes_connection(&shared)?;
    ack_operation_receipt(&connection, &session_id, &history_epoch, &operation_id)?;
    validate_notes_connection(&connection)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_clear_history(
    vault_path: String,
    input: NotesHistoryResetInput,
) -> Result<NotesHistoryResetResult, NotesError> {
    run_blocking(move || notes_clear_history_reset_inner(vault_path, input)).await
}

pub(crate) fn notes_clear_history_reset_inner(
    vault_path: String,
    input: NotesHistoryResetInput,
) -> Result<NotesHistoryResetResult, String> {
    let storage = AttachmentStorageLease::acquire(&vault_path)?;
    let shared = acquire_notes_connection(&vault_path)?;
    let mut connection = lock_notes_connection(&shared)?;
    let (workspace, result) = reset_history(&mut connection, &input)?;
    validate_notes_connection(&connection)?;
    reconcile_candidates_after_committed_change(
        &storage,
        &connection,
        &result.pruned_attachment_paths,
    );
    validate_notes_connection(&connection)?;
    Ok(NotesHistoryResetResult {
        workspace,
        history_reset: true,
        state: result.state,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_empty_trash(
    vault_path: String,
    input: NotesHistoryResetInput,
) -> Result<NotesHistoryResetResult, NotesError> {
    run_blocking(move || notes_empty_trash_reset_inner(vault_path, input)).await
}

pub(crate) fn notes_empty_trash_reset_inner(
    vault_path: String,
    input: NotesHistoryResetInput,
) -> Result<NotesHistoryResetResult, String> {
    let storage = AttachmentStorageLease::acquire(&vault_path)?;
    let shared = acquire_notes_connection(&vault_path)?;
    let mut connection = lock_notes_connection(&shared)?;
    let (workspace, result) = empty_trash_with_history_reset(&mut connection, &input)?;
    validate_notes_connection(&connection)?;
    reconcile_after_committed_attachment_change(&storage, &connection);
    validate_notes_connection(&connection)?;
    Ok(NotesHistoryResetResult {
        workspace,
        history_reset: true,
        state: result.state,
    })
}

#[cfg(test)]
pub(crate) fn notes_clear_history_legacy_inner(
    vault_path: String,
    session_id: String,
) -> Result<NotesHistoryState, String> {
    let epoch = notes_history_status_inner(vault_path.clone(), session_id.clone())?.history_epoch;
    notes_clear_history_reset_inner(
        vault_path,
        NotesHistoryResetInput {
            session_id,
            history_epoch: epoch,
        },
    )
    .map(|result| result.state)
}

#[cfg(test)]
pub(crate) fn notes_empty_trash_legacy_inner(vault_path: String) -> Result<NotesWorkspace, String> {
    let session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string();
    let epoch = notes_history_status_inner(vault_path.clone(), session_id.clone())?.history_epoch;
    notes_empty_trash_reset_inner(
        vault_path,
        NotesHistoryResetInput {
            session_id,
            history_epoch: epoch,
        },
    )
    .map(|result| result.workspace)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_prepare_navigation(
    vault_path: String,
    input: NotesPrepareNavigationInput,
) -> Result<NotesHistoryState, NotesError> {
    run_blocking(move || notes_prepare_navigation_inner(vault_path, input)).await
}

pub(crate) fn notes_prepare_navigation_inner(
    vault_path: String,
    input: NotesPrepareNavigationInput,
) -> Result<NotesHistoryState, String> {
    let storage = AttachmentStorageLease::acquire(&vault_path)?;
    let shared = acquire_notes_connection(&vault_path)?;
    let mut connection = lock_notes_connection(&shared)?;
    let result = prepare_navigation(&mut connection, &input)?;
    validate_notes_connection(&connection)?;
    reconcile_candidates_after_committed_change(
        &storage,
        &connection,
        &result.pruned_attachment_paths,
    );
    validate_notes_connection(&connection)?;
    Ok(result.state)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_prune_history_entries(
    vault_path: String,
    input: NotesPruneHistoryInput,
) -> Result<NotesHistoryState, NotesError> {
    run_blocking(move || notes_prune_history_entries_inner(vault_path, input)).await
}

pub(crate) fn notes_prune_history_entries_inner(
    vault_path: String,
    input: NotesPruneHistoryInput,
) -> Result<NotesHistoryState, String> {
    let storage = AttachmentStorageLease::acquire(&vault_path)?;
    let shared = acquire_notes_connection(&vault_path)?;
    let mut connection = lock_notes_connection(&shared)?;
    let result = prune_history_entries(&mut connection, &input)?;
    validate_notes_connection(&connection)?;
    reconcile_candidates_after_committed_change(
        &storage,
        &connection,
        &result.pruned_attachment_paths,
    );
    validate_notes_connection(&connection)?;
    Ok(result.state)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_close_history_session(
    vault_path: String,
    input: NotesHistoryCloseInput,
) -> Result<(), NotesError> {
    run_blocking(move || notes_close_history_session_inner(vault_path, input)).await
}

pub(crate) fn notes_close_history_session_inner(
    vault_path: String,
    input: NotesHistoryCloseInput,
) -> Result<(), String> {
    let result = (|| {
        let storage = AttachmentStorageLease::acquire(&vault_path)?;
        let shared = acquire_notes_connection(&vault_path)?;
        let mut connection = lock_notes_connection(&shared)?;
        let maintenance =
            close_all_history(&mut connection, &input.session_id, &input.history_epoch)?;
        validate_notes_connection(&connection)?;
        reconcile_candidates_after_committed_change_checked(
            &storage,
            &connection,
            &maintenance.pruned_attachment_paths,
        )?;
        validate_notes_connection(&connection)
    })();
    evict_notes_connection(&vault_path);
    result
}

fn attachment_metadata_error(
    storage: &AttachmentStorageLease,
    connection: &NotesConnectionGuard<'_>,
    error: String,
) -> String {
    match reconcile_attachment_files_for_active_connection(storage, connection) {
        Ok(_) => error,
        Err(reconcile_error) => {
            let _ = storage.mark_reconciliation_needed();
            format!("{error} Attachment reconciliation also failed: {reconcile_error}")
        }
    }
}

fn reconcile_attachment_files_for_active_connection(
    storage: &AttachmentStorageLease,
    connection: &NotesConnectionGuard<'_>,
) -> Result<usize, String> {
    let result = (|| {
        let identity = capture_validated_attachment_database_identity(storage, connection)?;
        storage.reconcile_attachment_files_validated(&**connection, &identity, || {
            validate_notes_connection(connection)
        })
    })();
    if result.is_err() {
        let _ = storage.mark_reconciliation_needed();
    }
    result
}

fn reconcile_attachment_candidates_with_identity(
    storage: &AttachmentStorageLease,
    connection: &NotesConnectionGuard<'_>,
    identity: &VaultStorageIdentity,
    candidates: &[String],
) -> Result<usize, String> {
    let result = storage.reconcile_attachment_candidates_validated(
        &**connection,
        identity,
        candidates,
        || validate_notes_connection(connection),
    );
    if result.is_err() {
        let _ = storage.mark_reconciliation_needed();
    }
    result
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
    connection: &NotesConnectionGuard<'_>,
) {
    match reconcile_attachment_files_for_active_connection(storage, connection) {
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
    connection: &NotesConnectionGuard<'_>,
    candidates: &[String],
) {
    if storage.reconciliation_needed().unwrap_or(true) {
        reconcile_after_committed_attachment_change(storage, connection);
        return;
    }
    let identity = match capture_validated_attachment_database_identity(storage, connection) {
        Ok(identity) => identity,
        Err(error) => {
            record_cleanup_warning(storage, error);
            return;
        }
    };
    if let Err(error) =
        reconcile_attachment_candidates_with_identity(storage, connection, &identity, candidates)
    {
        record_cleanup_warning(storage, error);
    }
}

fn reconcile_candidates_after_committed_change_checked(
    storage: &AttachmentStorageLease,
    connection: &NotesConnectionGuard<'_>,
    candidates: &[String],
) -> Result<(), String> {
    if storage.reconciliation_needed()? {
        reconcile_attachment_files_for_active_connection(storage, connection)?;
        storage.clear_reconciliation_marker()?;
        return Ok(());
    }
    let identity = capture_validated_attachment_database_identity(storage, connection)?;
    reconcile_attachment_candidates_with_identity(storage, connection, &identity, candidates)?;
    Ok(())
}

fn reconcile_before_attachment_batch(
    storage: &AttachmentStorageLease,
    connection: &NotesConnectionGuard<'_>,
) -> Result<(), String> {
    if storage.reconciliation_needed()? {
        reconcile_attachment_files_for_active_connection(storage, connection)?;
        storage.clear_reconciliation_marker()?;
    }
    Ok(())
}

fn reconcile_failed_attachment_batch(
    storage: &AttachmentStorageLease,
    connection: &NotesConnectionGuard<'_>,
    identity: &VaultStorageIdentity,
    candidates: &[String],
    error: String,
) -> String {
    let cleanup =
        reconcile_attachment_candidates_with_identity(storage, connection, identity, candidates)
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

fn reject_fresh_import_history_collision(
    connection: &rusqlite::Connection,
    history: &MutationHistory,
) -> Result<(), String> {
    let Some(context) = history.context() else {
        return Ok(());
    };
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_history_entries WHERE id = ?1)",
            [&context.entry_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not inspect fresh Notes import history: {error}"))?;
    if exists {
        return Err("A fresh Notes import cannot reuse an existing history entry.".to_string());
    }
    Ok(())
}

fn validate_committed_retry_assets(
    storage: &AttachmentStorageLease,
    attachments: &[NoteAttachment],
) -> Result<(), String> {
    for attachment in attachments {
        storage
            .read_validated_attachment_bytes(attachment)
            .map_err(|error| {
                format!(
                    "Could not verify committed Notes attachment retry asset {}: {error}",
                    attachment.id
                )
            })?;
    }
    Ok(())
}

fn committed_attachment_batch_retry(
    connection: &rusqlite::Connection,
    storage: &AttachmentStorageLease,
    expected: &[NewAttachment],
    history: &MutationHistory,
) -> Result<Option<NotesMutationResult>, String> {
    if let Some(context) = history.context() {
        require_epoch(connection, &context.history_epoch)?;
    }
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

    let history_entry_id = if let Some(context) = history.context() {
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

    validate_committed_retry_assets(storage, &existing)?;
    let status = match history.context() {
        Some(context) => history_status(connection, &context.session_id)?,
        None => NotesHistoryStatus::default(),
    };
    // This retry recognizes a batch a previous call already committed. To stay
    // idempotent with that original mutation it must report the same deltas.
    // The validation above proved the entry's only changes are these attachment
    // inserts (no node changes, nothing removed), so the delta is exactly the
    // committed attachments. Deltas are only exposed for the audited path; an
    // uncontexted original produced no audit rows and stays workspace-only.
    let deltas_available = history.context().is_some();
    Ok(Some(NotesMutationResult {
        workspace: load_workspace(connection, NotesWorkspaceScope::Active)?,
        history_entry_id,
        state: status,
        changed_nodes: deltas_available.then(Vec::new),
        removed_node_ids: deltas_available.then(Vec::new),
        changed_attachments: deltas_available.then(|| existing.clone()),
        imported_root_ids: None,
        duplicated_root_ids: None,
    }))
}

fn require_image_node_history_context(
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesHistoryContext, String> {
    let history_context = history_context
        .ok_or_else(|| "Notes image node imports require a history context.".to_string())?;
    validate_history_context(&history_context)?;
    Ok(history_context)
}

fn inconsistent_image_node_batch() -> String {
    "The requested Notes image node batch conflicts with inconsistent committed state.".to_string()
}

#[derive(Clone)]
struct RetryImageSibling {
    id: String,
    initial_sort_key: i64,
    sort_key: i64,
    existed_before: bool,
    was_rebalanced: bool,
}

fn retry_image_sort_key(
    siblings: &[RetryImageSibling],
    after_id: Option<&str>,
    before_first: bool,
) -> Result<Option<i64>, String> {
    if before_first {
        return match siblings.first() {
            Some(first) => Ok(first.sort_key.checked_sub(SORT_KEY_STEP)),
            None => Ok(Some(SORT_KEY_STEP)),
        };
    }
    let after_id = after_id.ok_or_else(inconsistent_image_node_batch)?;
    let index = siblings
        .iter()
        .position(|sibling| sibling.id == after_id)
        .ok_or_else(inconsistent_image_node_batch)?;
    let left = siblings[index].sort_key;
    match siblings.get(index + 1) {
        Some(right) => {
            let gap = i128::from(right.sort_key) - i128::from(left);
            if gap > 1 {
                Ok(Some((i128::from(left) + gap / 2) as i64))
            } else {
                Ok(None)
            }
        }
        None => Ok(left.checked_add(SORT_KEY_STEP)),
    }
}

fn simulate_committed_image_node_order(
    initial_siblings: Vec<(String, i64)>,
    expected_node_ids: &[String],
    after_id: Option<&str>,
) -> Result<Vec<RetryImageSibling>, String> {
    let mut siblings = initial_siblings
        .into_iter()
        .map(|(id, sort_key)| RetryImageSibling {
            id,
            initial_sort_key: sort_key,
            sort_key,
            existed_before: true,
            was_rebalanced: false,
        })
        .collect::<Vec<_>>();
    siblings.sort_by(|left, right| {
        left.sort_key
            .cmp(&right.sort_key)
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut previous_id = after_id.map(str::to_string);
    for (index, expected_node_id) in expected_node_ids.iter().enumerate() {
        let before_first = index == 0 && after_id.is_none();
        let sort_key = match retry_image_sort_key(&siblings, previous_id.as_deref(), before_first)?
        {
            Some(sort_key) => sort_key,
            None => {
                for (index, sibling) in siblings.iter_mut().enumerate() {
                    sibling.sort_key = i64::try_from(index + 1)
                        .ok()
                        .and_then(|position| position.checked_mul(SORT_KEY_STEP))
                        .ok_or_else(inconsistent_image_node_batch)?;
                    sibling.was_rebalanced = true;
                }
                retry_image_sort_key(&siblings, previous_id.as_deref(), before_first)?
                    .ok_or_else(inconsistent_image_node_batch)?
            }
        };
        siblings.push(RetryImageSibling {
            id: expected_node_id.clone(),
            initial_sort_key: sort_key,
            sort_key,
            existed_before: false,
            was_rebalanced: false,
        });
        siblings.sort_by(|left, right| {
            left.sort_key
                .cmp(&right.sort_key)
                .then_with(|| left.id.cmp(&right.id))
        });
        previous_id = Some(expected_node_id.clone());
    }
    Ok(siblings)
}

fn is_retry_rebalance_only_change(
    before_json: &str,
    after_json: &str,
    before: &NoteNode,
    after: &NoteNode,
    parent_id: Option<&str>,
) -> bool {
    if before.id != after.id
        || before.parent_id.as_deref() != parent_id
        || before.deleted_at.is_some()
        || before.archived_at.is_some()
    {
        return false;
    }
    let mut normalized = before.clone();
    normalized.sort_key = after.sort_key;
    normalized.updated_at.clone_from(&after.updated_at);
    if normalized != *after || before == after {
        return false;
    }

    let (
        Ok(serde_json::Value::Object(mut before_fields)),
        Ok(serde_json::Value::Object(after_fields)),
    ) = (
        serde_json::from_str::<serde_json::Value>(before_json),
        serde_json::from_str::<serde_json::Value>(after_json),
    )
    else {
        return false;
    };
    for field in ["sort_key", "updated_at"] {
        let Some(value) = after_fields.get(field).cloned() else {
            return false;
        };
        before_fields.insert(field.to_string(), value);
    }
    before_fields == after_fields
}

fn committed_image_node_batch_retry(
    connection: &rusqlite::Connection,
    storage: &AttachmentStorageLease,
    parent_id: Option<&str>,
    after_id: Option<&str>,
    expected_ids: &[(String, String)],
    expected_prepared: Option<&[NewImageNode]>,
    history_context: &NotesHistoryContext,
) -> Result<Option<NotesMutationResult>, String> {
    require_epoch(connection, &history_context.history_epoch)?;
    let node_exists = expected_ids
        .iter()
        .map(|(node_id, _)| {
            connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM notes_nodes WHERE id = ?1)",
                    [node_id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|error| format!("Could not inspect retry Notes image nodes: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let attachment_exists = expected_ids
        .iter()
        .map(|(_, attachment_id)| {
            connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM notes_attachments WHERE id = ?1)",
                    [attachment_id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|error| {
                    format!("Could not inspect retry Notes image attachments: {error}")
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let existing_count = node_exists.iter().filter(|exists| **exists).count()
        + attachment_exists.iter().filter(|exists| **exists).count();
    if existing_count == 0 {
        return Ok(None);
    }
    if existing_count != expected_ids.len() * 2 {
        return Err(inconsistent_image_node_batch());
    }

    let workspace = load_workspace(connection, NotesWorkspaceScope::Active)?;
    let mut actual_nodes = Vec::with_capacity(expected_ids.len());
    let mut actual_attachments = Vec::with_capacity(expected_ids.len());
    for (expected_node_id, expected_attachment_id) in expected_ids {
        let actual_node = workspace
            .nodes
            .iter()
            .find(|node| node.id == *expected_node_id)
            .cloned()
            .ok_or_else(inconsistent_image_node_batch)?;
        let actual_attachment = attachment_by_id(connection, expected_attachment_id)?
            .ok_or_else(inconsistent_image_node_batch)?;
        let owned_attachments = workspace
            .attachments_by_node_id
            .get(expected_node_id)
            .map(Vec::as_slice)
            .unwrap_or_default();
        if actual_node.node_kind != crate::notes::types::NoteNodeKind::Image
            || actual_node.parent_id.as_deref() != parent_id
            || !actual_node.note.is_empty()
            || owned_attachments.len() != 1
            || owned_attachments[0].id != *expected_attachment_id
        {
            return Err(inconsistent_image_node_batch());
        }
        if let Some(expected_prepared) = expected_prepared {
            let expected_node = expected_prepared
                .iter()
                .find(|node| node.id == *expected_node_id)
                .ok_or_else(inconsistent_image_node_batch)?;
            if actual_node.title != expected_node.title
                || !attachment_matches_prepared(&actual_attachment, &expected_node.attachment)
            {
                return Err(inconsistent_image_node_batch());
            }
        }
        actual_nodes.push(actual_node);
        actual_attachments.push(actual_attachment);
    }

    let current_siblings = connection
        .prepare(
            "SELECT id, sort_key FROM notes_nodes \
             WHERE parent_id IS ?1 AND deleted_at IS NULL AND archived_at IS NULL \
             ORDER BY sort_key, id",
        )
        .map_err(|error| format!("Could not prepare retry Notes image order: {error}"))?
        .query_map([parent_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|error| format!("Could not read retry Notes image order: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not collect retry Notes image order: {error}"))?;
    let sibling_ids = current_siblings
        .iter()
        .map(|(id, _)| id.as_str())
        .collect::<Vec<_>>();
    let start = match after_id {
        Some(after_id) => sibling_ids
            .iter()
            .position(|id| *id == after_id)
            .map(|index| index + 1)
            .ok_or_else(inconsistent_image_node_batch)?,
        None => 0,
    };
    let expected_node_ids = expected_ids
        .iter()
        .map(|(node_id, _)| node_id.as_str())
        .collect::<Vec<_>>();
    let actual_ids = sibling_ids
        .get(start..start.saturating_add(expected_ids.len()))
        .ok_or_else(inconsistent_image_node_batch)?;
    if actual_ids != expected_node_ids {
        return Err(inconsistent_image_node_batch());
    }

    let entry = connection
        .query_row(
            "SELECT session_id, command_kind, is_undone \
             FROM notes_history_entries WHERE id = ?1",
            [&history_context.entry_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Could not inspect retry Notes image history: {error}"))?;
    if entry.as_ref()
        != Some(&(
            history_context.session_id.clone(),
            history_context.command_kind.trim().to_string(),
            false,
        ))
    {
        return Err(inconsistent_image_node_batch());
    }

    let changes = connection
        .prepare(
            "SELECT table_name, row_id, before_json, after_json \
             FROM notes_history_changes WHERE entry_id = ?1 ORDER BY ordinal",
        )
        .map_err(|error| format!("Could not prepare retry Notes image history: {error}"))?
        .query_map([&history_context.entry_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|error| format!("Could not read retry Notes image history: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not collect retry Notes image history: {error}"))?;
    if changes.len() < expected_ids.len() * 2 {
        return Err(inconsistent_image_node_batch());
    }
    let mut matched_node_ids = HashSet::with_capacity(expected_ids.len());
    let mut matched_attachment_ids = HashSet::with_capacity(expected_ids.len());
    let mut rebalanced_before_by_id = HashMap::new();
    let mut changed_nodes = Vec::new();
    let mut changed_attachments = Vec::new();
    for (table_name, row_id, before_json, after_json) in changes {
        match table_name.as_str() {
            "notes_nodes" => {
                let after_json = after_json
                    .as_deref()
                    .ok_or_else(inconsistent_image_node_batch)?;
                let snapshot = note_node_from_audit_json(after_json)?;
                let current = workspace
                    .nodes
                    .iter()
                    .find(|node| node.id == row_id)
                    .ok_or_else(inconsistent_image_node_batch)?;
                if &snapshot != current {
                    return Err(inconsistent_image_node_batch());
                }
                if let Some(actual) = actual_nodes.iter().find(|node| node.id == row_id) {
                    if before_json.is_some()
                        || &snapshot != actual
                        || !matched_node_ids.insert(row_id)
                    {
                        return Err(inconsistent_image_node_batch());
                    }
                } else {
                    let before_json = before_json
                        .as_deref()
                        .ok_or_else(inconsistent_image_node_batch)?;
                    let before = note_node_from_audit_json(before_json)?;
                    if !is_retry_rebalance_only_change(
                        before_json,
                        after_json,
                        &before,
                        &snapshot,
                        parent_id,
                    ) || rebalanced_before_by_id.insert(row_id, before).is_some()
                    {
                        return Err(inconsistent_image_node_batch());
                    }
                }
                changed_nodes.push(snapshot);
            }
            "notes_attachments" => {
                if before_json.is_some() {
                    return Err(inconsistent_image_node_batch());
                }
                let actual = actual_attachments
                    .iter()
                    .find(|attachment| attachment.id == row_id)
                    .ok_or_else(inconsistent_image_node_batch)?;
                let snapshot = after_json
                    .as_deref()
                    .and_then(|json| serde_json::from_str::<NoteAttachment>(json).ok())
                    .ok_or_else(inconsistent_image_node_batch)?;
                if &snapshot != actual || !matched_attachment_ids.insert(row_id) {
                    return Err(inconsistent_image_node_batch());
                }
                changed_attachments.push(snapshot);
            }
            _ => return Err(inconsistent_image_node_batch()),
        }
    }
    if matched_node_ids.len() != expected_ids.len()
        || matched_attachment_ids.len() != expected_ids.len()
    {
        return Err(inconsistent_image_node_batch());
    }

    let expected_node_id_set = expected_ids
        .iter()
        .map(|(node_id, _)| node_id.as_str())
        .collect::<HashSet<_>>();
    let initial_siblings = current_siblings
        .iter()
        .filter(|(id, _)| !expected_node_id_set.contains(id.as_str()))
        .map(|(id, current_sort_key)| {
            let initial_sort_key = rebalanced_before_by_id
                .get(id)
                .map(|node| node.sort_key)
                .unwrap_or(*current_sort_key);
            (id.clone(), initial_sort_key)
        })
        .collect::<Vec<_>>();
    let expected_node_ids = expected_ids
        .iter()
        .map(|(node_id, _)| node_id.clone())
        .collect::<Vec<_>>();
    let simulated =
        simulate_committed_image_node_order(initial_siblings, &expected_node_ids, after_id)?;
    let simulated_current = simulated
        .iter()
        .map(|sibling| (sibling.id.as_str(), sibling.sort_key))
        .collect::<Vec<_>>();
    let actual_current = current_siblings
        .iter()
        .map(|(id, sort_key)| (id.as_str(), *sort_key))
        .collect::<Vec<_>>();
    if simulated_current != actual_current {
        return Err(inconsistent_image_node_batch());
    }
    let mut matched_rebalanced_ids = 0;
    for sibling in simulated.iter().filter(|sibling| sibling.existed_before) {
        if rebalanced_before_by_id.contains_key(&sibling.id) {
            if !sibling.was_rebalanced {
                return Err(inconsistent_image_node_batch());
            }
            matched_rebalanced_ids += 1;
        } else if sibling.sort_key != sibling.initial_sort_key {
            return Err(inconsistent_image_node_batch());
        }
    }
    if matched_rebalanced_ids != rebalanced_before_by_id.len() {
        return Err(inconsistent_image_node_batch());
    }

    validate_committed_retry_assets(storage, &actual_attachments)?;
    let status = history_status(connection, &history_context.session_id)?;
    Ok(Some(NotesMutationResult {
        workspace,
        history_entry_id: Some(history_context.entry_id.clone()),
        state: status,
        changed_nodes: Some(changed_nodes),
        removed_node_ids: Some(Vec::new()),
        changed_attachments: Some(changed_attachments),
        imported_root_ids: Some(expected_node_ids),
        duplicated_root_ids: None,
    }))
}

fn prepare_attachment_path_batch(
    source_paths: &[&str],
    import_permit: AttachmentImportPermit,
) -> Result<PreparedAttachmentBatch, String> {
    #[cfg(test)]
    let _timer =
        AttachmentBatchPerformanceStageTimer::start(AttachmentBatchPerformanceStage::Prepare);
    PreparedAttachmentBatch::from_source_paths_with_import_permit(source_paths, import_permit)
}

fn capture_validated_attachment_database_identity(
    storage: &AttachmentStorageLease,
    connection: &NotesConnectionGuard<'_>,
) -> Result<VaultStorageIdentity, String> {
    validate_notes_connection(connection)?;
    maybe_inject_attachment_before_database_identity_capture();
    let identity = storage.capture_database_identity(connection)?;
    validate_notes_connection(connection)?;
    Ok(identity)
}

fn import_prepared_attachment_batch(
    node_id: String,
    ids: Vec<String>,
    initial_max_display_width: i64,
    history: MutationHistory,
    prepared_batch: PreparedAttachmentBatch,
    storage: AttachmentStorageLease,
    connection: &mut NotesConnectionGuard<'_>,
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

    let identity = capture_validated_attachment_database_identity(&storage, connection)?;
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
        committed_attachment_batch_retry(&*connection, &storage, &attachments, &history)?
    {
        return Ok(result);
    }
    reject_fresh_import_history_collision(&*connection, &history)?;

    storage.mark_reconciliation_needed()?;
    let operation = |connection: &mut rusqlite::Connection| {
        create_attachments_coordinated_for_node(
            connection,
            &node_id,
            attachments,
            || {
                #[cfg(test)]
                let _timer = AttachmentBatchPerformanceStageTimer::start(
                    AttachmentBatchPerformanceStage::Publish,
                );
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
                // Test timing starts at the repository's before-commit callback boundary.
                #[cfg(test)]
                start_attachment_batch_commit_stage();
                storage.validate_identity(&identity)?;
                maybe_inject_attachment_batch_before_commit()
            },
        )
    };
    let result = match history.context() {
        Some(context) => {
            with_history_transaction_and_prunes(&mut *connection, Some(context), operation)
        }
        #[cfg(test)]
        None => with_untracked_transaction_and_prunes_for_test(&mut *connection, operation),
        #[cfg(not(test))]
        None => unreachable!("production attachment imports are always tracked"),
    };
    // Finish after the history wrapper returns so commit or rollback work is included.
    #[cfg(test)]
    {
        mark_attachment_batch_history_wrapper_returned();
        finish_attachment_batch_commit_stage(result.is_ok())
            .expect("attachment batch commit timing boundary");
    }

    match result {
        Ok(result) => {
            validate_notes_connection(connection)?;
            reconcile_after_committed_attachment_change(&storage, connection);
            Ok(result.into_mutation_result())
        }
        Err(error) => {
            if take_attachment_batch_crash_interruption() {
                Err(error)
            } else {
                Err(reconcile_failed_attachment_batch(
                    &storage,
                    connection,
                    &identity,
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
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    validate_vault_path(&vault_path).map_err(NotesError::from)?;
    let import_permit = acquire_import_permit_for_command().await?;
    run_blocking(move || {
        notes_import_attachment_paths_batch_with_permit_inner(
            vault_path,
            input,
            MutationHistory::Tracked(history_context),
            import_permit,
        )
    })
    .await
}

#[cfg(test)]
#[allow(dead_code)]
pub(crate) fn notes_import_attachment_paths_batch_inner(
    vault_path: String,
    input: ImportAttachmentPathBatchInput,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, String> {
    validate_vault_path(&vault_path)?;
    let import_permit = acquire_attachment_import_permit()?;
    notes_import_attachment_paths_batch_with_permit_inner(
        vault_path,
        input,
        MutationHistory::Tracked(history_context),
        import_permit,
    )
}

#[cfg(test)]
pub(crate) fn notes_import_attachment_paths_batch_with_optional_history_context_for_test(
    vault_path: String,
    input: ImportAttachmentPathBatchInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    validate_vault_path(&vault_path)?;
    let import_permit = acquire_attachment_import_permit()?;
    notes_import_attachment_paths_batch_with_permit_inner(
        vault_path,
        input,
        mutation_history_for_test(history_context),
        import_permit,
    )
}

fn notes_import_attachment_paths_batch_with_permit_inner(
    vault_path: String,
    input: ImportAttachmentPathBatchInput,
    history: MutationHistory,
    import_permit: AttachmentImportPermit,
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
    acquire_existing_vault_app_lock(&vault_path)?;
    // Decode the sources and read their files BEFORE taking the connection lock.
    // The prepare step is pure file I/O with no database dependency, and holding
    // the per-vault `Mutex` across it would block every read on this vault (e.g.
    // search keystrokes) for the whole import — the exact cross-command blocking
    // task 1.2 aims to avoid ("hold the lock only around the DB work").
    // `prepare_attachment_path_batch` wraps the permit-aware source preparation
    // with the Line B attachment-batch Prepare-stage timing probe (test-only), so
    // call the wrapper here to keep that instrumentation while preserving the
    // prepare-before-lock ordering.
    let prepared_batch = prepare_attachment_path_batch(&source_paths, import_permit)
        .map_err(|error| format!("Could not prepare Notes attachment batch: {error}"))?;
    let storage = AttachmentStorageLease::acquire(&vault_path)?;
    let shared = acquire_notes_connection(&vault_path)?;
    let mut connection = lock_notes_connection(&shared)?;
    reconcile_before_attachment_batch(&storage, &connection)?;
    let result = import_prepared_attachment_batch(
        input.node_id,
        ids,
        input.initial_max_display_width,
        history,
        prepared_batch,
        storage,
        &mut connection,
    )?;
    validate_notes_connection(&connection)?;
    Ok(result)
}

#[derive(Debug)]
struct OwnedRawAttachmentSource {
    original_name: String,
    declared_mime_type: String,
    byte_range: std::ops::Range<usize>,
}

#[derive(Debug)]
struct OwnedRawImportBody<M> {
    body: Vec<u8>,
    metadata: M,
    sources: Vec<OwnedRawAttachmentSource>,
    import_permit: AttachmentImportPermit,
}

#[derive(Debug)]
struct DecodedRawImport<M> {
    metadata: M,
    sources: Vec<OwnedRawAttachmentSource>,
}

fn own_raw_attachment_sources(
    body: &[u8],
    sources: Vec<RawAttachmentSource<'_>>,
) -> Result<Vec<OwnedRawAttachmentSource>, String> {
    let payload_bytes = sources.iter().try_fold(0_usize, |total, source| {
        total
            .checked_add(source.bytes.len())
            .ok_or_else(|| "The Notes raw import source ranges overflowed.".to_string())
    })?;
    let mut source_start = body
        .len()
        .checked_sub(payload_bytes)
        .ok_or_else(|| "The Notes raw import source ranges are invalid.".to_string())?;
    sources
        .into_iter()
        .map(|source| {
            let RawAttachmentSource {
                original_name,
                declared_mime_type,
                bytes,
            } = source;
            let source_end = source_start
                .checked_add(bytes.len())
                .ok_or_else(|| "The Notes raw import source range overflowed.".to_string())?;
            let owned = OwnedRawAttachmentSource {
                original_name,
                declared_mime_type,
                byte_range: source_start..source_end,
            };
            source_start = source_end;
            Ok(owned)
        })
        .collect()
}

fn prepare_owned_raw_import<M>(
    decoded: OwnedRawImportBody<M>,
) -> Result<(M, PreparedAttachmentBatch), String> {
    let sources = decoded
        .sources
        .iter()
        .map(|source| {
            let bytes = decoded.body.get(source.byte_range.clone()).ok_or_else(|| {
                "A validated Notes raw import source range is invalid.".to_string()
            })?;
            Ok(RawAttachmentSource {
                original_name: source.original_name.clone(),
                declared_mime_type: source.declared_mime_type.clone(),
                bytes,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let prepared_batch = PreparedAttachmentBatch::from_bytes_with_import_permit(
        sources,
        decoded.import_permit.clone(),
    )?;
    let OwnedRawImportBody {
        body,
        metadata,
        sources: _,
        import_permit,
    } = decoded;
    drop(body);
    drop(import_permit);
    Ok((metadata, prepared_batch))
}

fn decode_raw_body_with<'a, M, D>(
    body: &'a [u8],
    decode: impl FnOnce(&'a [u8]) -> Result<D, String>,
    into_parts: impl FnOnce(D) -> (M, Vec<RawAttachmentSource<'a>>),
) -> Result<DecodedRawImport<M>, String> {
    let decoded = decode(body)?;
    let (metadata, sources) = into_parts(decoded);
    let sources = own_raw_attachment_sources(body, sources)?;
    Ok(DecodedRawImport { metadata, sources })
}

fn own_decoded_raw_body_with<M>(
    body: &[u8],
    decoded: DecodedRawImport<M>,
    import_permit: AttachmentImportPermit,
    copy_body: impl FnOnce(&[u8]) -> Vec<u8>,
) -> OwnedRawImportBody<M> {
    let body = copy_body(body);
    OwnedRawImportBody {
        body,
        metadata: decoded.metadata,
        sources: decoded.sources,
        import_permit,
    }
}

fn decode_raw_attachment_body(
    body: &[u8],
) -> Result<DecodedRawImport<ImportAttachmentBytesMetadata>, String> {
    let decoded = decode_raw_body_with(body, decode_raw_attachment_envelope, |decoded| {
        (decoded.metadata, decoded.sources)
    })?;
    validate_history_context(
        decoded
            .metadata
            .history_context
            .as_ref()
            .ok_or_else(|| "A Notes mutation requires a history context.".to_string())?,
    )?;
    Ok(decoded)
}

#[cfg(test)]
fn decode_and_own_raw_attachment_body_with(
    body: &[u8],
    copy_body: impl FnOnce(&[u8]) -> Vec<u8>,
) -> Result<OwnedRawImportBody<ImportAttachmentBytesMetadata>, String> {
    let decoded = decode_raw_attachment_body(body)?;
    let import_permit = acquire_attachment_import_permit()?;
    Ok(own_decoded_raw_body_with(
        body,
        decoded,
        import_permit,
        copy_body,
    ))
}

fn import_raw_attachment_batch(
    metadata: ImportAttachmentBytesMetadata,
    prepared_batch: PreparedAttachmentBatch,
) -> Result<NotesMutationResult, String> {
    let history_context = metadata
        .history_context
        .ok_or_else(|| "A Notes mutation requires a history context.".to_string())?;
    validate_history_context(&history_context)?;
    let ids = metadata
        .attachments
        .iter()
        .map(|attachment| attachment.id.clone())
        .collect::<Vec<_>>();
    validate_attachment_batch_ids(&metadata.node_id, &ids)?;
    let storage = AttachmentStorageLease::acquire(&metadata.vault_path)?;
    let shared = acquire_notes_connection(&metadata.vault_path)?;
    let mut connection = lock_notes_connection(&shared)?;
    reconcile_before_attachment_batch(&storage, &connection)?;
    let result = import_prepared_attachment_batch(
        metadata.node_id,
        ids,
        metadata.initial_max_display_width,
        MutationHistory::Tracked(history_context),
        prepared_batch,
        storage,
        &mut connection,
    )?;
    validate_notes_connection(&connection)?;
    Ok(result)
}

#[cfg(test)]
fn notes_import_attachment_bytes_body(body: &[u8]) -> Result<NotesMutationResult, String> {
    let decoded = decode_raw_attachment_envelope(body)?;
    let prepared_batch = PreparedAttachmentBatch::from_bytes(decoded.sources)?;
    import_raw_attachment_batch(decoded.metadata, prepared_batch)
}

fn notes_import_owned_attachment_bytes_body(
    decoded: OwnedRawImportBody<ImportAttachmentBytesMetadata>,
) -> Result<NotesMutationResult, String> {
    let (metadata, prepared_batch) = prepare_owned_raw_import(decoded)?;
    import_raw_attachment_batch(metadata, prepared_batch)
}

#[tauri::command]
pub(crate) async fn notes_import_attachment_bytes(
    request: tauri::ipc::Request<'_>,
) -> Result<NotesMutationResult, NotesError> {
    let (raw_body, decoded) = match request.body() {
        tauri::ipc::InvokeBody::Raw(body) => (
            body.as_slice(),
            decode_raw_attachment_body(body).map_err(NotesError::from)?,
        ),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(NotesError::new(
                NotesErrorCode::Internal,
                "Notes attachment byte imports require a raw IPC body.",
            ));
        }
    };
    acquire_existing_vault_app_lock(&decoded.metadata.vault_path).map_err(NotesError::from)?;
    let import_permit = acquire_import_permit_for_command().await?;
    let body = own_decoded_raw_body_with(raw_body, decoded, import_permit, <[u8]>::to_vec);
    run_blocking(move || notes_import_owned_attachment_bytes_body(body)).await
}

fn import_prepared_image_node_batch(
    parent_id: Option<String>,
    after_id: Option<String>,
    ids: Vec<(String, String)>,
    initial_max_display_width: i64,
    history_context: NotesHistoryContext,
    prepared_batch: PreparedAttachmentBatch,
    storage: AttachmentStorageLease,
    connection: &mut NotesConnectionGuard<'_>,
) -> Result<NotesMutationResult, String> {
    validate_image_node_batch_fields(
        parent_id.as_deref(),
        after_id.as_deref(),
        initial_max_display_width,
        ids.iter()
            .map(|(node_id, attachment_id)| (node_id.as_str(), attachment_id.as_str())),
    )?;
    if ids.len() != prepared_batch.attachments().len() {
        return Err("Notes image node metadata does not match the prepared batch.".to_string());
    }

    let imported_root_ids = ids
        .iter()
        .map(|(node_id, _)| node_id.clone())
        .collect::<Vec<_>>();
    let mut nodes = Vec::with_capacity(ids.len());
    for ((node_id, attachment_id), prepared) in ids.into_iter().zip(prepared_batch.attachments()) {
        let byte_size = i64::try_from(prepared.image.byte_size)
            .map_err(|_| "The Notes attachment byte size is too large.".to_string())?;
        let attachment = NewAttachment {
            id: attachment_id,
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
        };
        nodes.push(NewImageNode {
            id: node_id,
            title: String::new(),
            attachment,
        });
    }
    let candidates = nodes
        .iter()
        .map(|node| node.attachment.relative_path.clone())
        .collect::<Vec<_>>();
    let committed_ids = nodes
        .iter()
        .map(|node| (node.id.clone(), node.attachment.id.clone()))
        .collect::<Vec<_>>();

    if let Some(result) = committed_image_node_batch_retry(
        &*connection,
        &storage,
        parent_id.as_deref(),
        after_id.as_deref(),
        &committed_ids,
        Some(&nodes),
        &history_context,
    )? {
        return Ok(result);
    }
    let history = MutationHistory::Tracked(history_context.clone());
    reject_fresh_import_history_collision(&*connection, &history)?;

    reconcile_before_attachment_batch(&storage, connection)?;
    let identity = capture_validated_attachment_database_identity(&storage, connection)?;
    storage.mark_reconciliation_needed()?;
    let result = with_history_transaction_and_prunes(
        &mut *connection,
        Some(&history_context),
        |connection| {
            create_image_nodes_coordinated(
                connection,
                parent_id.as_deref(),
                after_id.as_deref(),
                nodes,
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
                                "Published Notes image node path did not match its prepared metadata."
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
            validate_notes_connection(connection)?;
            reconcile_after_committed_attachment_change(&storage, connection);
            let mut mutation = result.into_mutation_result();
            mutation.imported_root_ids = Some(imported_root_ids);
            Ok(mutation)
        }
        Err(error) => {
            if take_attachment_batch_crash_interruption() {
                Err(error)
            } else {
                Err(reconcile_failed_attachment_batch(
                    &storage,
                    connection,
                    &identity,
                    &candidates,
                    error,
                ))
            }
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_import_image_node_paths_batch(
    vault_path: String,
    input: ImportImageNodePathsInput,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    validate_vault_path(&vault_path).map_err(NotesError::from)?;
    let import_permit = acquire_import_permit_for_command().await?;
    run_blocking(move || {
        notes_import_image_node_paths_batch_with_permit_inner(
            vault_path,
            input,
            history_context,
            import_permit,
        )
    })
    .await
}

#[cfg(test)]
pub(crate) fn notes_import_image_node_paths_batch_inner(
    vault_path: String,
    input: ImportImageNodePathsInput,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, String> {
    validate_vault_path(&vault_path)?;
    let import_permit = acquire_attachment_import_permit()?;
    notes_import_image_node_paths_batch_with_permit_inner(
        vault_path,
        input,
        history_context,
        import_permit,
    )
}

#[cfg(test)]
pub(crate) fn notes_import_image_node_paths_batch_with_optional_history_context_for_test(
    vault_path: String,
    input: ImportImageNodePathsInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    let history_context = require_image_node_history_context(history_context)?;
    notes_import_image_node_paths_batch_inner(vault_path, input, history_context)
}

fn notes_import_image_node_paths_batch_with_permit_inner(
    vault_path: String,
    input: ImportImageNodePathsInput,
    history_context: NotesHistoryContext,
    import_permit: AttachmentImportPermit,
) -> Result<NotesMutationResult, String> {
    input.validate()?;
    let committed_ids = input
        .items
        .iter()
        .map(|item| (item.node_id.clone(), item.attachment_id.clone()))
        .collect::<Vec<_>>();
    if let Some(_app_lock) = try_acquire_existing_vault_app_lock(&vault_path)? {
        let storage = AttachmentStorageLease::acquire(&vault_path)?;
        let shared = acquire_notes_connection(&vault_path)?;
        let connection = lock_notes_connection(&shared)?;
        if let Some(result) = committed_image_node_batch_retry(
            &connection,
            &storage,
            input.parent_id.as_deref(),
            input.after_id.as_deref(),
            &committed_ids,
            None,
            &history_context,
        )? {
            maybe_inject_image_node_retry_before_return();
            validate_notes_connection(&connection)?;
            return Ok(result);
        }
    }
    let source_paths = input
        .items
        .iter()
        .map(|item| item.source_path.as_str())
        .collect::<Vec<_>>();
    let prepared_batch =
        PreparedAttachmentBatch::from_source_paths_with_import_permit(&source_paths, import_permit)
            .map_err(|error| format!("Could not prepare Notes image node batch: {error}"))?;
    let ids = input
        .items
        .into_iter()
        .map(|item| (item.node_id, item.attachment_id))
        .collect::<Vec<_>>();
    let storage = AttachmentStorageLease::acquire(&vault_path)?;
    let shared = acquire_notes_connection(&vault_path)?;
    let mut connection = lock_notes_connection(&shared)?;
    let result = import_prepared_image_node_batch(
        input.parent_id,
        input.after_id,
        ids,
        input.initial_max_display_width,
        history_context,
        prepared_batch,
        storage,
        &mut connection,
    )?;
    validate_notes_connection(&connection)?;
    Ok(result)
}

#[cfg(test)]
fn notes_import_image_node_bytes_body(body: &[u8]) -> Result<NotesMutationResult, String> {
    let decoded = decode_raw_image_node_envelope(body)?;
    let prepared_batch = PreparedAttachmentBatch::from_bytes(decoded.sources)?;
    import_raw_image_node_batch(decoded.metadata, prepared_batch)
}

fn import_raw_image_node_batch(
    metadata: ImportImageNodeBytesMetadata,
    prepared_batch: PreparedAttachmentBatch,
) -> Result<NotesMutationResult, String> {
    let history_context = require_image_node_history_context(metadata.history_context.clone())?;
    let ids = metadata
        .items
        .into_iter()
        .map(|item| (item.node_id, item.attachment_id))
        .collect::<Vec<_>>();
    let storage = AttachmentStorageLease::acquire(&metadata.vault_path)?;
    let shared = acquire_notes_connection(&metadata.vault_path)?;
    let mut connection = lock_notes_connection(&shared)?;
    let result = import_prepared_image_node_batch(
        metadata.parent_id,
        metadata.after_id,
        ids,
        metadata.initial_max_display_width,
        history_context,
        prepared_batch,
        storage,
        &mut connection,
    )?;
    validate_notes_connection(&connection)?;
    Ok(result)
}

fn decode_raw_image_node_body(
    body: &[u8],
) -> Result<DecodedRawImport<ImportImageNodeBytesMetadata>, String> {
    decode_raw_body_with(
        body,
        |body| {
            let decoded = decode_raw_image_node_envelope(body)?;
            require_image_node_history_context(decoded.metadata.history_context.clone())?;
            Ok(decoded)
        },
        |decoded| (decoded.metadata, decoded.sources),
    )
}

#[cfg(test)]
fn decode_and_own_raw_image_node_body_with(
    body: &[u8],
    copy_body: impl FnOnce(&[u8]) -> Vec<u8>,
) -> Result<OwnedRawImportBody<ImportImageNodeBytesMetadata>, String> {
    let decoded = decode_raw_image_node_body(body)?;
    let import_permit = acquire_attachment_import_permit()?;
    Ok(own_decoded_raw_body_with(
        body,
        decoded,
        import_permit,
        copy_body,
    ))
}

fn notes_import_owned_image_node_bytes_body(
    decoded: OwnedRawImportBody<ImportImageNodeBytesMetadata>,
) -> Result<NotesMutationResult, String> {
    let (metadata, prepared_batch) = prepare_owned_raw_import(decoded)?;
    import_raw_image_node_batch(metadata, prepared_batch)
}

#[tauri::command]
pub(crate) async fn notes_import_image_node_bytes(
    request: tauri::ipc::Request<'_>,
) -> Result<NotesMutationResult, NotesError> {
    let (raw_body, decoded) = match request.body() {
        tauri::ipc::InvokeBody::Raw(body) => (
            body.as_slice(),
            decode_raw_image_node_body(body).map_err(NotesError::from)?,
        ),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(NotesError::new(
                NotesErrorCode::Internal,
                "Notes image node byte imports require a raw IPC body.",
            ));
        }
    };
    acquire_existing_vault_app_lock(&decoded.metadata.vault_path).map_err(NotesError::from)?;
    let import_permit = acquire_import_permit_for_command().await?;
    let body = own_decoded_raw_body_with(raw_body, decoded, import_permit, <[u8]>::to_vec);
    run_blocking(move || notes_import_owned_image_node_bytes_body(body)).await
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_import_attachment(
    vault_path: String,
    input: ImportAttachmentInput,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    notes_import_attachment_paths_batch(
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
    .await
}

#[cfg(test)]
#[allow(dead_code)]
pub(crate) fn notes_import_attachment_inner(
    vault_path: String,
    input: ImportAttachmentInput,
    history_context: NotesHistoryContext,
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

#[cfg(test)]
pub(crate) fn notes_import_attachment_with_optional_history_context_for_test(
    vault_path: String,
    input: ImportAttachmentInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    notes_import_attachment_paths_batch_with_optional_history_context_for_test(
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

const ATTACHMENT_VIEW_ROOT_NAME: &str = "yonalist-notes-originals";
const ATTACHMENT_VIEW_COPY_PREFIX: &str = "yonalist-notes-original-";
const MAX_ATTACHMENT_VIEW_COPY_COMPONENT_BYTES: usize = 255;
const ATTACHMENT_VIEW_COPY_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_RETAINED_ATTACHMENT_VIEW_COPIES: usize = 32;
const MAX_SCANNED_ATTACHMENT_VIEW_ENTRIES: usize = 256;
const MAX_STALE_ATTACHMENT_VIEW_COPY_REMOVALS: usize = 8;
const MAX_ATTACHMENT_DOWNLOAD_RELOCATION_SCAN_ENTRIES: usize = 2048;
const ATTACHMENT_DOWNLOAD_TEMP_PREFIX: &str = ".yonalist-attachment-download-";
const ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME: &str = "download";
#[cfg(windows)]
const ATTACHMENT_DOWNLOAD_BACKUP_FILE_NAME: &str = "replaced";
#[cfg(any(windows, test))]
const WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
static ATTACHMENT_VIEW_COPY_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static ATTACHMENT_DOWNLOAD_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CapabilityFileIdentity {
    device: u64,
    inode: u64,
}

fn attachment_file_identity(metadata: &impl CapabilityMetadataExt) -> CapabilityFileIdentity {
    CapabilityFileIdentity {
        device: CapabilityMetadataExt::dev(metadata),
        inode: CapabilityMetadataExt::ino(metadata),
    }
}

fn read_current_attachment_bytes(
    vault_path: &str,
    attachment_id: &str,
) -> Result<(AttachmentStorageLease, NoteAttachment, Vec<u8>), String> {
    let storage = AttachmentStorageLease::acquire(vault_path)?;
    let shared = acquire_notes_connection(vault_path)?;
    let attachment = {
        let connection = lock_notes_connection(&shared)?;
        attachment_by_id(&connection, attachment_id)?
            .ok_or_else(|| format!("Notes attachment {attachment_id} does not exist."))?
    };
    let bytes = storage.read_validated_attachment_bytes(&attachment)?;
    Ok((storage, attachment, bytes))
}

fn canonical_attachment_extension(mime_type: &str) -> Result<&'static str, String> {
    match mime_type {
        "image/png" => Ok("png"),
        "image/jpeg" => Ok("jpg"),
        "image/webp" => Ok("webp"),
        "image/gif" => Ok("gif"),
        _ => Err("The Notes attachment MIME type is unsupported.".to_string()),
    }
}

fn safe_attachment_view_stem(original_name: &str) -> String {
    let basename = original_name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(original_name);
    let stem = Path::new(basename)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let sanitized = stem
        .chars()
        .filter_map(|value| {
            if value.is_alphanumeric() || matches!(value, ' ' | '-' | '_') {
                Some(value)
            } else if value.is_whitespace() {
                Some(' ')
            } else {
                None
            }
        })
        .collect::<String>();
    let sanitized = sanitized.trim();
    if sanitized.is_empty() {
        "image".to_string()
    } else {
        sanitized.to_string()
    }
}

fn truncate_utf8_to_bytes(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = 0;
    for (index, character) in value.char_indices() {
        let next = index + character.len_utf8();
        if next > max_bytes {
            break;
        }
        end = next;
    }
    &value[..end]
}

fn windows_reserved_device_stem(value: &str) -> bool {
    let value = value.to_ascii_uppercase();
    matches!(value.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || value
            .strip_prefix("COM")
            .or_else(|| value.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
}

#[cfg(any(windows, test))]
fn attachment_download_windows_attributes_are_safe(file_attributes: u32) -> bool {
    file_attributes & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT == 0
}

fn open_attachment_view_root_nofollow(root: &Path) -> Result<Dir, String> {
    if root.file_name().and_then(|value| value.to_str()) != Some(ATTACHMENT_VIEW_ROOT_NAME) {
        return Err("The Notes attachment view root name is invalid.".to_string());
    }
    let parent = root
        .parent()
        .ok_or_else(|| "Could not resolve the Notes attachment view root parent.".to_string())?;
    let parent = fs::canonicalize(parent).map_err(|error| {
        format!("Could not resolve the Notes attachment view root parent: {error}")
    })?;
    let parent = Dir::open_ambient_dir(&parent, ambient_authority()).map_err(|error| {
        format!("Could not open the Notes attachment view root parent: {error}")
    })?;
    let root = parent
        .open_dir_nofollow(ATTACHMENT_VIEW_ROOT_NAME)
        .map_err(|error| {
            format!(
                "The Notes attachment view root must be an owned directory, not a symlink: {error}"
            )
        })?;
    if !root
        .dir_metadata()
        .map_err(|error| format!("Could not inspect the Notes attachment view root: {error}"))?
        .is_dir()
    {
        return Err("The Notes attachment view root must be a directory.".to_string());
    }
    Ok(root)
}

#[cfg(unix)]
fn validate_attachment_view_root_for_uid(root: &Dir, expected_uid: u32) -> Result<(), String> {
    let metadata = root
        .dir_metadata()
        .map_err(|error| format!("Could not inspect the Notes attachment view root: {error}"))?;
    if CapUnixMetadataExt::uid(&metadata) != expected_uid {
        return Err(
            "The Notes attachment view root owner does not match the current user.".to_string(),
        );
    }
    if CapUnixMetadataExt::mode(&metadata) & 0o777 != 0o700 {
        return Err(
            "The Notes attachment view root must be private to its owner (mode 0700).".to_string(),
        );
    }
    Ok(())
}

#[cfg(windows)]
const WINDOWS_ATTACHMENT_VIEW_DIRECTORY_ACE_FLAGS: u32 =
    windows_sys::Win32::Security::OBJECT_INHERIT_ACE
        | windows_sys::Win32::Security::CONTAINER_INHERIT_ACE;

#[cfg(windows)]
struct WindowsPrivateSecurityDescriptor {
    descriptor: windows_sys::Win32::Security::SECURITY_DESCRIPTOR,
    _sid: Vec<usize>,
    _acl: Vec<usize>,
}

#[cfg(windows)]
fn attachment_view_windows_aligned_buffer(byte_len: u32) -> Vec<usize> {
    let word_size = std::mem::size_of::<usize>();
    let words = (byte_len as usize + word_size - 1) / word_size;
    vec![0; words]
}

#[cfg(windows)]
fn attachment_view_windows_path(path: &Path) -> Result<Vec<u16>, String> {
    use std::os::windows::ffi::OsStrExt;

    let mut wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
    if wide.iter().any(|value| *value == 0) {
        return Err("A Windows Notes attachment view path contains an invalid NUL.".to_string());
    }
    wide.push(0);
    Ok(wide)
}

#[cfg(windows)]
impl WindowsPrivateSecurityDescriptor {
    fn new(ace_flags: u32) -> Result<Self, String> {
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::Security::{
            AddAccessAllowedAceEx, CopySid, GetLengthSid, GetTokenInformation, InitializeAcl,
            InitializeSecurityDescriptor, IsValidSid, SetSecurityDescriptorControl,
            SetSecurityDescriptorDacl, SetSecurityDescriptorOwner, TokenUser, ACCESS_ALLOWED_ACE,
            ACL, ACL_REVISION, PSECURITY_DESCRIPTOR, PSID, SECURITY_DESCRIPTOR, SE_DACL_PROTECTED,
            TOKEN_USER,
        };
        use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;

        const CURRENT_PROCESS_TOKEN: HANDLE = -4_isize as HANDLE;
        const SECURITY_DESCRIPTOR_REVISION: u32 = 1;

        let mut token_bytes = 0_u32;
        unsafe {
            GetTokenInformation(
                CURRENT_PROCESS_TOKEN,
                TokenUser,
                std::ptr::null_mut(),
                0,
                &mut token_bytes,
            );
        }
        if token_bytes == 0 {
            return Err(format!(
                "Could not size the current Windows user token: {}",
                io::Error::last_os_error()
            ));
        }
        let mut token = attachment_view_windows_aligned_buffer(token_bytes);
        if unsafe {
            GetTokenInformation(
                CURRENT_PROCESS_TOKEN,
                TokenUser,
                token.as_mut_ptr().cast(),
                token_bytes,
                &mut token_bytes,
            )
        } == 0
        {
            return Err(format!(
                "Could not read the current Windows user token: {}",
                io::Error::last_os_error()
            ));
        }
        let token_user = unsafe { &*(token.as_ptr().cast::<TOKEN_USER>()) };
        if unsafe { IsValidSid(token_user.User.Sid) } == 0 {
            return Err("The current Windows user token contains an invalid SID.".to_string());
        }
        let sid_len = unsafe { GetLengthSid(token_user.User.Sid) };
        if sid_len == 0 {
            return Err("The current Windows user SID has an invalid length.".to_string());
        }
        let mut sid = attachment_view_windows_aligned_buffer(sid_len);
        if unsafe {
            CopySid(
                sid_len,
                sid.as_mut_ptr().cast::<std::ffi::c_void>() as PSID,
                token_user.User.Sid,
            )
        } == 0
        {
            return Err(format!(
                "Could not copy the current Windows user SID: {}",
                io::Error::last_os_error()
            ));
        }

        let ace_size = std::mem::size_of::<ACCESS_ALLOWED_ACE>()
            .checked_sub(std::mem::size_of::<u32>())
            .and_then(|size| size.checked_add(sid_len as usize))
            .ok_or_else(|| "The Windows Notes attachment ACL size overflowed.".to_string())?;
        let acl_size = std::mem::size_of::<ACL>()
            .checked_add(ace_size)
            .ok_or_else(|| "The Windows Notes attachment ACL size overflowed.".to_string())?;
        let acl_size = u32::try_from(acl_size)
            .map_err(|_| "The Windows Notes attachment ACL is too large.".to_string())?;
        let mut acl = attachment_view_windows_aligned_buffer(acl_size);
        let acl_ptr = acl.as_mut_ptr().cast::<ACL>();
        if unsafe { InitializeAcl(acl_ptr, acl_size, ACL_REVISION) } == 0 {
            return Err(format!(
                "Could not initialize the Windows Notes attachment ACL: {}",
                io::Error::last_os_error()
            ));
        }
        let sid_ptr = sid.as_mut_ptr().cast::<std::ffi::c_void>() as PSID;
        if unsafe {
            AddAccessAllowedAceEx(acl_ptr, ACL_REVISION, ace_flags, FILE_ALL_ACCESS, sid_ptr)
        } == 0
        {
            return Err(format!(
                "Could not grant the current user access to the Windows Notes attachment cache: {}",
                io::Error::last_os_error()
            ));
        }

        let mut descriptor = SECURITY_DESCRIPTOR::default();
        let descriptor_ptr = (&mut descriptor as *mut SECURITY_DESCRIPTOR)
            .cast::<std::ffi::c_void>() as PSECURITY_DESCRIPTOR;
        if unsafe { InitializeSecurityDescriptor(descriptor_ptr, SECURITY_DESCRIPTOR_REVISION) }
            == 0
            || unsafe { SetSecurityDescriptorOwner(descriptor_ptr, sid_ptr, 0) } == 0
            || unsafe { SetSecurityDescriptorDacl(descriptor_ptr, 1, acl_ptr, 0) } == 0
            || unsafe {
                SetSecurityDescriptorControl(descriptor_ptr, SE_DACL_PROTECTED, SE_DACL_PROTECTED)
            } == 0
        {
            return Err(format!(
                "Could not build the private Windows Notes attachment security descriptor: {}",
                io::Error::last_os_error()
            ));
        }
        Ok(Self {
            descriptor,
            _sid: sid,
            _acl: acl,
        })
    }

    fn descriptor_ptr(&mut self) -> windows_sys::Win32::Security::PSECURITY_DESCRIPTOR {
        (&mut self.descriptor as *mut windows_sys::Win32::Security::SECURITY_DESCRIPTOR)
            .cast::<std::ffi::c_void>()
    }

    fn sid_ptr(&self) -> windows_sys::Win32::Security::PSID {
        self._sid.as_ptr().cast::<std::ffi::c_void>() as *mut std::ffi::c_void
    }

    fn security_attributes(&mut self) -> windows_sys::Win32::Security::SECURITY_ATTRIBUTES {
        windows_sys::Win32::Security::SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<windows_sys::Win32::Security::SECURITY_ATTRIBUTES>()
                as u32,
            lpSecurityDescriptor: self.descriptor_ptr(),
            bInheritHandle: 0,
        }
    }
}

#[cfg(windows)]
fn attachment_view_windows_security_descriptor(
    handle: windows_sys::Win32::Foundation::HANDLE,
    information: u32,
) -> Result<Vec<usize>, String> {
    use windows_sys::Win32::Security::GetKernelObjectSecurity;

    let mut bytes = 0_u32;
    unsafe {
        GetKernelObjectSecurity(handle, information, std::ptr::null_mut(), 0, &mut bytes);
    }
    if bytes == 0 {
        return Err(format!(
            "Could not size Windows Notes attachment security information: {}",
            io::Error::last_os_error()
        ));
    }
    let mut descriptor = attachment_view_windows_aligned_buffer(bytes);
    if unsafe {
        GetKernelObjectSecurity(
            handle,
            information,
            descriptor.as_mut_ptr().cast(),
            bytes,
            &mut bytes,
        )
    } == 0
    {
        return Err(format!(
            "Could not read Windows Notes attachment security information: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(descriptor)
}

#[cfg(windows)]
fn validate_attachment_view_windows_acl(
    handle: windows_sys::Win32::Foundation::HANDLE,
    expected_ace_flags: u32,
) -> Result<(), String> {
    use windows_sys::Win32::Security::{
        AclSizeInformation, EqualSid, GetAce, GetAclInformation, GetSecurityDescriptorControl,
        GetSecurityDescriptorDacl, GetSecurityDescriptorOwner, ACCESS_ALLOWED_ACE, ACL,
        ACL_REVISION, ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, PSID, SE_DACL_AUTO_INHERITED, SE_DACL_PROTECTED,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;

    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

    let expected = WindowsPrivateSecurityDescriptor::new(expected_ace_flags)?;
    let descriptor = attachment_view_windows_security_descriptor(
        handle,
        OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    )?;
    let descriptor_ptr = descriptor.as_ptr().cast::<std::ffi::c_void>() as PSECURITY_DESCRIPTOR;

    let mut owner: PSID = std::ptr::null_mut();
    let mut owner_defaulted = 0;
    if unsafe { GetSecurityDescriptorOwner(descriptor_ptr, &mut owner, &mut owner_defaulted) } == 0
        || owner.is_null()
        || owner_defaulted != 0
        || unsafe { EqualSid(owner, expected.sid_ptr()) } == 0
    {
        return Err(
            "The Windows Notes attachment cache owner does not match the current user.".to_string(),
        );
    }

    let mut control = 0_u16;
    let mut revision = 0_u32;
    if unsafe { GetSecurityDescriptorControl(descriptor_ptr, &mut control, &mut revision) } == 0
        || control & SE_DACL_PROTECTED == 0
        || control & SE_DACL_AUTO_INHERITED != 0
    {
        return Err(
            "The Windows Notes attachment cache DACL must be protected from inheritance."
                .to_string(),
        );
    }

    let mut dacl_present = 0;
    let mut dacl_defaulted = 0;
    let mut dacl: *mut ACL = std::ptr::null_mut();
    if unsafe {
        GetSecurityDescriptorDacl(
            descriptor_ptr,
            &mut dacl_present,
            &mut dacl,
            &mut dacl_defaulted,
        )
    } == 0
        || dacl_present == 0
        || dacl.is_null()
        || dacl_defaulted != 0
        || unsafe { (*dacl).AclRevision } != ACL_REVISION as u8
    {
        return Err("The Windows Notes attachment cache DACL is invalid.".to_string());
    }

    let mut acl_info = ACL_SIZE_INFORMATION::default();
    if unsafe {
        GetAclInformation(
            dacl,
            (&mut acl_info as *mut ACL_SIZE_INFORMATION).cast(),
            std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
        || acl_info.AceCount != 1
        || acl_info.AclBytesFree != 0
    {
        return Err(
            "The Windows Notes attachment cache DACL must contain exactly one access rule."
                .to_string(),
        );
    }

    let mut ace_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
    if unsafe { GetAce(dacl, 0, &mut ace_ptr) } == 0 || ace_ptr.is_null() {
        return Err(
            "Could not inspect the Windows Notes attachment cache access rule.".to_string(),
        );
    }
    let ace = unsafe { &*(ace_ptr.cast::<ACCESS_ALLOWED_ACE>()) };
    let ace_sid = (&ace.SidStart as *const u32).cast::<std::ffi::c_void>()
        as windows_sys::Win32::Security::PSID;
    let expected_ace_size = std::mem::size_of::<ACCESS_ALLOWED_ACE>()
        .checked_sub(std::mem::size_of::<u32>())
        .and_then(|size| unsafe {
            windows_sys::Win32::Security::GetLengthSid(expected.sid_ptr())
                .try_into()
                .ok()
                .and_then(|sid_len: usize| size.checked_add(sid_len))
        })
        .ok_or_else(|| "The Windows Notes attachment access-rule size overflowed.".to_string())?;
    if ace.Header.AceType != ACCESS_ALLOWED_ACE_TYPE
        || ace.Header.AceFlags != expected_ace_flags as u8
        || ace.Header.AceSize as usize != expected_ace_size
        || ace.Mask != FILE_ALL_ACCESS
        || unsafe { EqualSid(ace_sid, expected.sid_ptr()) } == 0
    {
        return Err(
            "The Windows Notes attachment cache DACL grants unexpected access.".to_string(),
        );
    }
    Ok(())
}

#[cfg(windows)]
fn validate_attachment_view_windows_handle(
    handle: windows_sys::Win32::Foundation::HANDLE,
    directory: bool,
    expected_ace_flags: u32,
) -> Result<(), String> {
    use windows_sys::Win32::Storage::FileSystem::{
        FileAttributeTagInfo, FileStandardInfo, GetFileInformationByHandleEx,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_STANDARD_INFO,
    };

    let mut attributes = FILE_ATTRIBUTE_TAG_INFO::default();
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileAttributeTagInfo,
            (&mut attributes as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0
        || attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(
            "A Windows Notes attachment cache object must not be a reparse point.".to_string(),
        );
    }
    let mut standard = FILE_STANDARD_INFO::default();
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileStandardInfo,
            (&mut standard as *mut FILE_STANDARD_INFO).cast(),
            std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
        )
    } == 0
        || standard.Directory != directory
        || (!directory && standard.NumberOfLinks != 1)
    {
        return Err(
            "A Windows Notes attachment cache object has an unsafe type or link count.".to_string(),
        );
    }
    validate_attachment_view_windows_acl(handle, expected_ace_flags)
}

#[cfg(windows)]
fn validate_attachment_view_windows_root(root: &Dir) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;

    validate_attachment_view_windows_handle(
        root.as_raw_handle() as HANDLE,
        true,
        WINDOWS_ATTACHMENT_VIEW_DIRECTORY_ACE_FLAGS,
    )
}

fn validate_attachment_view_root_security(root: &Dir) -> Result<(), String> {
    #[cfg(unix)]
    {
        return validate_attachment_view_root_for_uid(root, rustix::process::geteuid().as_raw());
    }
    #[cfg(windows)]
    {
        return validate_attachment_view_windows_root(root);
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = root;
        Ok(())
    }
}

#[cfg(test)]
fn open_existing_attachment_view_root(root: &Path) -> Result<Dir, String> {
    let root = open_attachment_view_root_nofollow(root)?;
    validate_attachment_view_root_security(&root)?;
    Ok(root)
}

#[cfg(all(test, unix))]
fn open_existing_attachment_view_root_for_uid(
    root: &Path,
    expected_uid: u32,
) -> Result<Dir, String> {
    let root = open_attachment_view_root_nofollow(root)?;
    validate_attachment_view_root_for_uid(&root, expected_uid)?;
    Ok(root)
}

fn prepare_attachment_view_parent(parent: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(parent).map_err(|error| {
        format!("Could not create the Notes attachment view parent directory: {error}")
    })?;
    fs::canonicalize(parent).map_err(|error| {
        format!("Could not resolve the Notes attachment view parent directory: {error}")
    })
}

struct AttachmentViewRootGuards {
    #[cfg(windows)]
    _ancestors: Vec<Dir>,
}

#[cfg(windows)]
fn hold_attachment_view_windows_ancestors(path: &Path) -> Result<Vec<Dir>, String> {
    let mut paths = path.ancestors().collect::<Vec<_>>();
    paths.reverse();
    let mut guards = Vec::with_capacity(paths.len());
    for path in paths {
        if path.as_os_str().is_empty() {
            continue;
        }
        guards.push(
            Dir::open_ambient_dir(path, ambient_authority()).map_err(|error| {
                format!("Could not pin a Windows Notes attachment cache ancestor: {error}")
            })?,
        );
    }
    Ok(guards)
}

#[cfg(windows)]
fn create_private_attachment_view_root_windows(path: &Path) -> Result<bool, String> {
    use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;

    let mut security =
        WindowsPrivateSecurityDescriptor::new(WINDOWS_ATTACHMENT_VIEW_DIRECTORY_ACE_FLAGS)?;
    let attributes = security.security_attributes();
    let path = attachment_view_windows_path(path)?;
    if unsafe { CreateDirectoryW(path.as_ptr(), &attributes) } != 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.kind() == ErrorKind::AlreadyExists {
        Ok(false)
    } else {
        Err(format!(
            "Could not create the private Windows Notes attachment view root: {error}"
        ))
    }
}

fn prepare_attachment_view_root(
    temp_parent: &Path,
    vault_path: &str,
) -> Result<
    (
        PathBuf,
        Dir,
        CapabilityFileIdentity,
        AttachmentViewRootGuards,
    ),
    String,
> {
    let temp_parent = fs::canonicalize(temp_parent).map_err(|error| {
        format!("Could not resolve the Notes attachment view parent directory: {error}")
    })?;
    let vault_root = fs::canonicalize(vault_path)
        .map_err(|error| format!("Could not resolve the Notes vault directory: {error}"))?;
    let root_path = temp_parent.join(ATTACHMENT_VIEW_ROOT_NAME);
    if root_path == vault_root
        || root_path.starts_with(&vault_root)
        || vault_root.starts_with(&root_path)
    {
        return Err("The Notes Vault and attachment view root must not overlap.".to_string());
    }

    #[cfg(windows)]
    let ancestor_guards = hold_attachment_view_windows_ancestors(&temp_parent)?;
    let parent = Dir::open_ambient_dir(&temp_parent, ambient_authority()).map_err(|error| {
        format!("Could not open the Notes attachment view parent directory: {error}")
    })?;
    let (root, created) = match parent.open_dir_nofollow(ATTACHMENT_VIEW_ROOT_NAME) {
        Ok(root) => (root, false),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            #[cfg(windows)]
            let created = create_private_attachment_view_root_windows(&root_path)?;
            #[cfg(not(windows))]
            let created = {
                let mut builder = DirBuilder::new();
                #[cfg(unix)]
                CapDirBuilderExt::mode(&mut builder, 0o700);
                match parent.create_dir_with(ATTACHMENT_VIEW_ROOT_NAME, &builder) {
                    Ok(()) => true,
                    Err(error) if error.kind() == ErrorKind::AlreadyExists => false,
                    Err(error) => {
                        return Err(format!(
                            "Could not create the Notes attachment view root: {error}"
                        ))
                    }
                }
            };
            let root = parent
                .open_dir_nofollow(ATTACHMENT_VIEW_ROOT_NAME)
                .map_err(|error| {
                    format!(
                        "The Notes attachment view root must be an owned directory, not a symlink: {error}"
                    )
                })?;
            (root, created)
        }
        Err(error) => {
            return Err(format!(
                "The Notes attachment view root must be an owned directory, not a symlink: {error}"
            ))
        }
    };
    #[cfg(not(windows))]
    let _ = created;
    #[cfg(windows)]
    if !created {
        validate_attachment_view_windows_root(&root).map_err(|error| {
            format!(
                "Refused to reuse a Windows Notes attachment cache without the exact private security contract: {error}"
            )
        })?;
    }
    validate_attachment_view_root_security(&root)?;
    let root_identity =
        attachment_file_identity(&root.dir_metadata().map_err(|error| {
            format!("Could not inspect the Notes attachment view root: {error}")
        })?);
    Ok((
        root_path,
        root,
        root_identity,
        AttachmentViewRootGuards {
            #[cfg(windows)]
            _ancestors: ancestor_guards,
        },
    ))
}

fn is_attachment_view_copy_name(name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    if !name.starts_with(ATTACHMENT_VIEW_COPY_PREFIX) {
        return false;
    }
    matches!(
        Path::new(name).extension().and_then(|value| value.to_str()),
        Some("png" | "jpg" | "webp" | "gif")
    )
}

struct AttachmentViewCopyCleanupCandidate {
    modified: SystemTime,
    file_name: OsString,
}

fn attachment_view_copy_cleanup_candidates(
    root: &Dir,
) -> Result<Vec<AttachmentViewCopyCleanupCandidate>, String> {
    let entries = root
        .entries()
        .map_err(|error| format!("Could not inspect Notes attachment view copies: {error}"))?;
    let mut candidates = Vec::new();
    for entry in entries {
        let entry = entry
            .map_err(|error| format!("Could not inspect a Notes attachment view copy: {error}"))?;
        let file_name = entry.file_name();
        if !is_attachment_view_copy_name(&file_name) {
            continue;
        }
        let file_type = entry.file_type().map_err(|error| {
            format!("Could not inspect a Notes attachment view copy type: {error}")
        })?;
        if !file_type.is_file() {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .map(|modified| modified.into_std())
            .unwrap_or(UNIX_EPOCH);
        candidates.push(AttachmentViewCopyCleanupCandidate {
            modified,
            file_name,
        });
        if candidates.len() == MAX_SCANNED_ATTACHMENT_VIEW_ENTRIES {
            break;
        }
    }
    candidates.sort_by(|left, right| {
        left.modified
            .cmp(&right.modified)
            .then_with(|| left.file_name.cmp(&right.file_name))
    });
    Ok(candidates)
}

fn cleanup_attachment_view_copies_to_limit(
    root: &Dir,
    now: SystemTime,
    retained_limit: usize,
) -> Result<usize, String> {
    let candidates = attachment_view_copy_cleanup_candidates(root)?;
    let mut overflow_removals_remaining = candidates.len().saturating_sub(retained_limit);
    let mut removed = 0;
    for AttachmentViewCopyCleanupCandidate {
        modified,
        file_name,
    } in candidates
    {
        let stale = now
            .duration_since(modified)
            .is_ok_and(|age| age >= ATTACHMENT_VIEW_COPY_MAX_AGE);
        let overflow_candidate = overflow_removals_remaining > 0;
        if !overflow_candidate && !stale {
            continue;
        }
        match remove_attachment_view_copy(root, &file_name) {
            Ok(()) => {
                if overflow_candidate {
                    overflow_removals_remaining -= 1;
                }
                removed += 1;
                if removed == MAX_STALE_ATTACHMENT_VIEW_COPY_REMOVALS {
                    break;
                }
            }
            Err(error) => {
                eprintln!(
                    "Notes attachment view-copy cleanup warning: Could not remove a stale Notes attachment view copy: {error}"
                );
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
fn cleanup_attachment_view_copies_with_root(root: &Dir, now: SystemTime) -> Result<usize, String> {
    cleanup_attachment_view_copies_to_limit(root, now, MAX_RETAINED_ATTACHMENT_VIEW_COPIES)
}

fn attachment_view_copy_count_with_root(root: &Dir) -> Result<usize, String> {
    Ok(attachment_view_copy_cleanup_candidates(root)?.len())
}

fn prepare_attachment_view_copy_capacity(root: &Dir, now: SystemTime) -> Result<(), String> {
    let retained_limit = MAX_RETAINED_ATTACHMENT_VIEW_COPIES
        .checked_sub(1)
        .ok_or_else(|| "Notes attachment view-copy capacity is invalid.".to_string())?;
    cleanup_attachment_view_copies_to_limit(root, now, retained_limit)?;
    let retained = attachment_view_copy_count_with_root(root)?;
    if retained > retained_limit {
        return Err(format!(
            "Notes attachment view-copy cleanup could not make capacity for a new verified copy \
             (retained {retained}, limit {MAX_RETAINED_ATTACHMENT_VIEW_COPIES})."
        ));
    }
    Ok(())
}

fn ensure_attachment_view_copy_capacity_after_create(root: &Dir) -> Result<(), String> {
    let retained = attachment_view_copy_count_with_root(root)?;
    if retained > MAX_RETAINED_ATTACHMENT_VIEW_COPIES {
        return Err(format!(
            "Notes attachment view-copy retention exceeded capacity after creating a verified copy \
             (retained {retained}, limit {MAX_RETAINED_ATTACHMENT_VIEW_COPIES})."
        ));
    }
    Ok(())
}

#[cfg(test)]
fn cleanup_attachment_view_copies(root: &Path, now: SystemTime) -> Result<usize, String> {
    let root = open_existing_attachment_view_root(root)?;
    cleanup_attachment_view_copies_with_root(&root, now)
}

#[cfg(test)]
fn maybe_inject_attachment_view_copy_remove_fault(root: &Dir, file_name: &OsStr) -> io::Result<()> {
    let fault = ATTACHMENT_VIEW_COPY_REMOVE_FAULT.with(|slot| slot.borrow().clone());
    match fault {
        Some(AttachmentViewCopyRemoveFault::PermissionDeniedIfReadonly) => {
            if root.symlink_metadata(file_name)?.permissions().readonly() {
                return Err(io::Error::new(
                    ErrorKind::PermissionDenied,
                    "injected Windows read-only delete denial",
                ));
            }
        }
        Some(AttachmentViewCopyRemoveFault::PermissionDeniedForName(expected))
            if file_name == expected.as_os_str() =>
        {
            return Err(io::Error::new(
                ErrorKind::PermissionDenied,
                "injected view-copy delete denial",
            ));
        }
        Some(AttachmentViewCopyRemoveFault::PermissionDeniedForAll) => {
            return Err(io::Error::new(
                ErrorKind::PermissionDenied,
                "injected view-copy delete denial",
            ));
        }
        Some(AttachmentViewCopyRemoveFault::PermissionDeniedAfterReadonlyClearForName(
            expected,
        )) if file_name == expected.as_os_str() => {
            return Err(io::Error::new(
                ErrorKind::PermissionDenied,
                "injected view-copy delete denial after read-only clear",
            ));
        }
        _ => {}
    }
    Ok(())
}

#[cfg(not(test))]
fn maybe_inject_attachment_view_copy_remove_fault(
    _root: &Dir,
    _file_name: &OsStr,
) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
fn injected_attachment_view_copy_delete_requires_writable() -> bool {
    ATTACHMENT_VIEW_COPY_REMOVE_FAULT.with(|slot| {
        matches!(
            &*slot.borrow(),
            Some(
                AttachmentViewCopyRemoveFault::PermissionDeniedIfReadonly
                    | AttachmentViewCopyRemoveFault::PermissionDeniedAfterReadonlyClearForName(_)
            )
        )
    })
}

#[cfg(not(test))]
fn injected_attachment_view_copy_delete_requires_writable() -> bool {
    false
}

fn attachment_view_copy_delete_requires_writable_attribute() -> bool {
    cfg!(windows) || injected_attachment_view_copy_delete_requires_writable()
}

fn clear_attachment_view_copy_readonly(
    root: &Dir,
    file_name: &OsStr,
) -> io::Result<Option<Permissions>> {
    let metadata = root.symlink_metadata(file_name)?;
    if !metadata.is_file() {
        return Ok(None);
    }
    let mut permissions = metadata.permissions();
    if !permissions.readonly() {
        return Ok(None);
    }
    let original_permissions = permissions.clone();
    permissions.set_readonly(false);
    root.set_permissions(file_name, permissions)?;
    Ok(Some(original_permissions))
}

fn remove_attachment_view_copy(root: &Dir, file_name: &OsStr) -> io::Result<()> {
    let original_permissions = if attachment_view_copy_delete_requires_writable_attribute() {
        clear_attachment_view_copy_readonly(root, file_name)?
    } else {
        None
    };
    let removal_result = maybe_inject_attachment_view_copy_remove_fault(root, file_name)
        .and_then(|()| root.remove_file(file_name));
    let Err(removal_error) = removal_result else {
        return Ok(());
    };
    if let Some(original_permissions) = original_permissions {
        if let Err(restoration_error) = root.set_permissions(file_name, original_permissions) {
            let kind = removal_error.kind();
            return Err(io::Error::new(
                kind,
                format!(
                    "{removal_error}; additionally could not restore the Notes attachment view copy's read-only permissions: {restoration_error}"
                ),
            ));
        }
    }
    Err(removal_error)
}

#[cfg(windows)]
fn create_private_attachment_view_copy_windows(path: &Path) -> io::Result<cap_std::fs::File> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_READ, READ_CONTROL,
    };

    let mut security = WindowsPrivateSecurityDescriptor::new(0)
        .map_err(|error| io::Error::new(ErrorKind::PermissionDenied, error))?;
    let attributes = security.security_attributes();
    let path = attachment_view_windows_path(path)
        .map_err(|error| io::Error::new(ErrorKind::InvalidInput, error))?;
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
            FILE_SHARE_READ,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { fs::File::from_raw_handle(handle as *mut std::ffi::c_void) };
    Ok(cap_std::fs::File::from_std(file))
}

#[cfg(windows)]
fn validate_attachment_view_windows_copy(file: &cap_std::fs::File) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;

    validate_attachment_view_windows_handle(file.as_raw_handle() as HANDLE, false, 0)
}

struct AttachmentViewCopy {
    file_name: String,
    path: PathBuf,
    identity: CapabilityFileIdentity,
    #[cfg(windows)]
    pinned_file: Option<cap_std::fs::File>,
}

fn create_attachment_view_copy(
    root_path: &Path,
    root: &Dir,
    attachment: &NoteAttachment,
    bytes: &[u8],
) -> Result<AttachmentViewCopy, String> {
    let extension = canonical_attachment_extension(&attachment.mime_type)?;
    let stem = safe_attachment_view_stem(&attachment.original_name);
    for _ in 0..64 {
        let sequence = ATTACHMENT_VIEW_COPY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let suffix = format!(
            "-{timestamp:x}-{:x}-{sequence:x}.{extension}",
            std::process::id()
        );
        let stem_budget = MAX_ATTACHMENT_VIEW_COPY_COMPONENT_BYTES
            .checked_sub(ATTACHMENT_VIEW_COPY_PREFIX.len() + suffix.len())
            .ok_or_else(|| {
                "Could not allocate a safe Notes attachment view copy name.".to_string()
            })?;
        let stem = truncate_utf8_to_bytes(&stem, stem_budget);
        let file_name = format!("{ATTACHMENT_VIEW_COPY_PREFIX}{stem}{suffix}");
        debug_assert!(file_name.len() <= MAX_ATTACHMENT_VIEW_COPY_COMPONENT_BYTES);
        #[cfg(windows)]
        let file_result = create_private_attachment_view_copy_windows(&root_path.join(&file_name));
        #[cfg(not(windows))]
        let file_result = {
            let mut options = OpenOptions::new();
            options
                .write(true)
                .create_new(true)
                .follow(FollowSymlinks::No);
            #[cfg(unix)]
            CapOpenOptionsExt::mode(&mut options, 0o600);
            root.open_with(&file_name, &options)
        };
        let mut file = match file_result {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Could not create a verified Notes attachment view copy: {error}"
                ))
            }
        };
        let result = (|| {
            file.write_all(bytes).map_err(|error| {
                format!("Could not write a verified Notes attachment view copy: {error}")
            })?;
            file.sync_all().map_err(|error| {
                format!("Could not sync a verified Notes attachment view copy: {error}")
            })?;
            #[cfg(unix)]
            let permissions = CapPermissionsExt::from_mode(0o400);
            #[cfg(not(unix))]
            let permissions = {
                let mut permissions = file
                    .metadata()
                    .map_err(|error| {
                        format!("Could not inspect a Notes attachment view copy: {error}")
                    })?
                    .permissions();
                permissions.set_readonly(true);
                permissions
            };
            file.set_permissions(permissions).map_err(|error| {
                format!("Could not make a Notes attachment view copy read-only: {error}")
            })?;
            let metadata = file.metadata().map_err(|error| {
                format!("Could not inspect a verified Notes attachment view copy: {error}")
            })?;
            if !metadata.is_file() {
                return Err(
                    "A verified Notes attachment view copy must be a regular file.".to_string(),
                );
            }
            if CapabilityMetadataExt::nlink(&metadata) != 1 {
                return Err(
                    "A verified Notes attachment view copy must not be hard-linked.".to_string(),
                );
            }
            #[cfg(windows)]
            validate_attachment_view_windows_copy(&file)?;
            Ok(attachment_file_identity(&metadata))
        })();
        let identity = match result {
            Ok(identity) => identity,
            Err(error) => {
                drop(file);
                let _ = remove_attachment_view_copy(root, OsStr::new(&file_name));
                return Err(error);
            }
        };
        #[cfg(not(windows))]
        drop(file);
        return Ok(AttachmentViewCopy {
            path: root_path.join(&file_name),
            file_name,
            identity,
            #[cfg(windows)]
            pinned_file: Some(file),
        });
    }
    Err("Could not allocate a unique Notes attachment view copy name.".to_string())
}

fn validate_attachment_view_copy_link_count(link_count: u64) -> Result<(), String> {
    if link_count != 1 {
        return Err("A verified Notes attachment view copy must not be hard-linked.".to_string());
    }
    Ok(())
}

fn validate_attachment_view_copy_for_open(
    root_path: &Path,
    root: &Dir,
    root_identity: CapabilityFileIdentity,
    copy: &AttachmentViewCopy,
) -> Result<(), String> {
    let reopened_root = open_attachment_view_root_nofollow(root_path)?;
    validate_attachment_view_root_security(&reopened_root)?;
    let reopened_identity =
        attachment_file_identity(&reopened_root.dir_metadata().map_err(|error| {
            format!("Could not inspect the Notes attachment view root: {error}")
        })?);
    if reopened_identity != root_identity {
        return Err(
            "The Notes attachment view root changed before opening the verified copy.".to_string(),
        );
    }

    #[cfg(windows)]
    {
        let pinned_file = copy.pinned_file.as_ref().ok_or_else(|| {
            "The Windows Notes attachment view copy is not pinned for opening.".to_string()
        })?;
        validate_attachment_view_windows_copy(pinned_file)?;
        let pinned_metadata = pinned_file.metadata().map_err(|error| {
            format!("Could not inspect the pinned Notes attachment view copy: {error}")
        })?;
        validate_attachment_view_copy_link_count(CapabilityMetadataExt::nlink(&pinned_metadata))?;
        if attachment_file_identity(&pinned_metadata) != copy.identity {
            return Err(
                "The pinned Notes attachment view copy changed before opening.".to_string(),
            );
        }
    }

    let held_metadata = root
        .symlink_metadata(Path::new(&copy.file_name))
        .map_err(|error| {
            format!("Could not inspect the held Notes attachment view copy: {error}")
        })?;
    if !held_metadata.is_file() {
        return Err("The held Notes attachment view copy must be a regular file.".to_string());
    }
    validate_attachment_view_copy_link_count(CapabilityMetadataExt::nlink(&held_metadata))?;
    if attachment_file_identity(&held_metadata) != copy.identity {
        return Err("The held Notes attachment view copy changed before opening.".to_string());
    }

    let ambient_metadata = reopened_root
        .symlink_metadata(Path::new(&copy.file_name))
        .map_err(|error| {
            format!("Could not inspect the Notes attachment view copy path: {error}")
        })?;
    if !ambient_metadata.is_file() {
        return Err("The Notes attachment view copy path must be a regular file.".to_string());
    }
    validate_attachment_view_copy_link_count(CapabilityMetadataExt::nlink(&ambient_metadata))?;
    if attachment_file_identity(&ambient_metadata) != copy.identity {
        return Err("The Notes attachment view copy path changed before opening.".to_string());
    }

    // Platform opener APIs accept a path, not this capability. Keep this check
    // immediately adjacent to dispatch. Unix still has a same-user path race;
    // Windows additionally pins every ancestor and denies write/delete sharing
    // on the copy through synchronous ShellExecuteExW dispatch, but an arbitrary
    // handler provides no acknowledgement that it has consumed the path.
    Ok(())
}

#[cfg(test)]
fn maybe_inject_attachment_view_copy_before_open_validation(
    root_path: &Path,
    copy: &AttachmentViewCopy,
) -> Result<(), String> {
    let fault = ATTACHMENT_VIEW_COPY_OPEN_VALIDATION_FAULT.with(|slot| slot.borrow().clone());
    match fault {
        Some(AttachmentViewCopyOpenValidationFault::ReplaceRoot { moved_root }) => {
            if moved_root.exists() {
                fs::remove_dir_all(&moved_root).map_err(|error| {
                    format!("Could not reset injected moved view root: {error}")
                })?;
            }
            fs::rename(root_path, &moved_root)
                .map_err(|error| format!("Could not inject moved view root: {error}"))?;
            fs::create_dir(root_path)
                .map_err(|error| format!("Could not inject replacement view root: {error}"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;

                fs::set_permissions(root_path, fs::Permissions::from_mode(0o700)).map_err(
                    |error| {
                        format!("Could not make injected replacement view root private: {error}")
                    },
                )?;
            }
        }
        Some(AttachmentViewCopyOpenValidationFault::ReplaceCopyWithFile) => {
            fs::remove_file(&copy.path)
                .map_err(|error| format!("Could not inject view copy replacement: {error}"))?;
            fs::write(&copy.path, b"replacement").map_err(|error| {
                format!("Could not write injected view copy replacement: {error}")
            })?;
        }
        Some(AttachmentViewCopyOpenValidationFault::HardlinkCopy { link_path }) => {
            fs::hard_link(&copy.path, &link_path)
                .map_err(|error| format!("Could not inject view copy hard link: {error}"))?;
        }
        None => {}
    }
    Ok(())
}

#[cfg(not(test))]
fn maybe_inject_attachment_view_copy_before_open_validation(
    _root_path: &Path,
    _copy: &AttachmentViewCopy,
) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
#[cfg_attr(target_arch = "x86", repr(C, packed(1)))]
#[cfg_attr(not(target_arch = "x86"), repr(C))]
struct AttachmentShellExecuteInfoW {
    cb_size: u32,
    mask: u32,
    window: *mut std::ffi::c_void,
    verb: *const u16,
    file: *const u16,
    parameters: *const u16,
    directory: *const u16,
    show: i32,
    instance: *mut std::ffi::c_void,
    id_list: *mut std::ffi::c_void,
    class: *const u16,
    class_key: *mut std::ffi::c_void,
    hot_key: u32,
    icon_or_monitor: *mut std::ffi::c_void,
    process: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
fn open_attachment_original_windows(path: &Path) -> Result<(), String> {
    use windows_sys::Win32::Foundation::CloseHandle;

    const SEE_MASK_NOCLOSEPROCESS: u32 = 0x0000_0040;
    const SEE_MASK_NOASYNC: u32 = 0x0000_0100;
    const SEE_MASK_FLAG_NO_UI: u32 = 0x0000_0400;
    const SW_SHOWNORMAL: i32 = 1;

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteExW(info: *mut AttachmentShellExecuteInfoW) -> i32;
    }

    let path = attachment_view_windows_path(path)?;
    let open_verb = [b'o' as u16, b'p' as u16, b'e' as u16, b'n' as u16, 0];
    let mut info: AttachmentShellExecuteInfoW = unsafe { std::mem::zeroed() };
    info.cb_size = std::mem::size_of::<AttachmentShellExecuteInfoW>() as u32;
    info.mask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
    info.verb = open_verb.as_ptr();
    info.file = path.as_ptr();
    info.show = SW_SHOWNORMAL;
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        return Err(format!(
            "Could not open the verified Notes attachment copy: {}",
            io::Error::last_os_error()
        ));
    }
    if !info.process.is_null() {
        unsafe {
            CloseHandle(info.process);
        }
    }

    // ShellExecuteExW accepts a path rather than a file handle. The protected
    // root/ancestor handles and the deny-write/delete file handle remain live
    // through this synchronous dispatch, but Windows does not expose a protocol
    // proving when an arbitrary same-user handler has consumed the path.
    Ok(())
}

fn notes_open_attachment_original_with_opener(
    vault_path: String,
    attachment_id: String,
    temp_parent: &Path,
    opener: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let (storage, attachment, bytes) = read_current_attachment_bytes(&vault_path, &attachment_id)?;
    let temp_parent = prepare_attachment_view_parent(temp_parent)?;
    let (root_path, root, root_identity, _root_guards) =
        prepare_attachment_view_root(&temp_parent, &vault_path)?;
    prepare_attachment_view_copy_capacity(&root, SystemTime::now())?;
    let copy = create_attachment_view_copy(&root_path, &root, &attachment, &bytes)?;
    #[cfg(windows)]
    let mut copy = copy;
    let result = (|| {
        ensure_attachment_view_copy_capacity_after_create(&root)?;
        maybe_inject_attachment_view_copy_before_open_validation(&root_path, &copy)?;
        validate_attachment_view_copy_for_open(&root_path, &root, root_identity, &copy)?;
        opener(&copy.path)
    })();
    if result.is_err() {
        #[cfg(windows)]
        drop(copy.pinned_file.take());
        if let Err(error) = remove_attachment_view_copy(&root, OsStr::new(&copy.file_name)) {
            eprintln!("Notes attachment view-copy opener cleanup warning: {error}");
        }
    }
    drop(storage);
    result
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_open_attachment_original(
    app: tauri::AppHandle,
    vault_path: String,
    attachment_id: String,
) -> Result<(), NotesError> {
    let app_cache_parent = app.path().app_cache_dir().map_err(|error| {
        format!("Could not resolve the per-user Notes application cache directory: {error}")
    });
    run_blocking(move || {
        notes_open_attachment_original_inner(vault_path, attachment_id, app_cache_parent?)
    })
    .await
}

pub(crate) fn notes_open_attachment_original_inner(
    vault_path: String,
    attachment_id: String,
    temp_parent: PathBuf,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        return notes_open_attachment_original_with_opener(
            vault_path,
            attachment_id,
            &temp_parent,
            open_attachment_original_windows,
        );
    }
    #[cfg(not(windows))]
    notes_open_attachment_original_with_opener(vault_path, attachment_id, &temp_parent, |path| {
        open::that(path).map_err(|error| error.to_string())
    })
}

struct PreparedAttachmentDownloadDestination {
    parent: Dir,
    file_name: OsString,
    parent_path: PathBuf,
    parent_identity: CapabilityFileIdentity,
    vault_root: PathBuf,
    #[cfg(windows)]
    _ancestor_guards: Vec<Dir>,
}

#[cfg(windows)]
fn hold_attachment_download_windows_ancestors(path: &Path) -> Result<Vec<Dir>, String> {
    let mut paths = path.ancestors().collect::<Vec<_>>();
    paths.reverse();
    let mut guards = Vec::with_capacity(paths.len());
    for path in paths {
        if path.as_os_str().is_empty() {
            continue;
        }
        guards.push(
            Dir::open_ambient_dir(path, ambient_authority()).map_err(|error| {
                format!("Could not pin an attachment download destination ancestor: {error}")
            })?,
        );
    }
    Ok(guards)
}

fn attachment_capability_metadata_matches(
    expected: &cap_std::fs::Metadata,
    held: &cap_std::fs::Metadata,
) -> bool {
    attachment_file_identity(expected) == attachment_file_identity(held)
}

#[cfg(windows)]
const _: fn(&cap_std::fs::Metadata, &cap_std::fs::Metadata) -> bool =
    attachment_capability_metadata_matches;

fn open_canonical_directory_nofollow(path: &Path) -> Result<(Dir, CapabilityFileIdentity), String> {
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(file_name)) => {
            let parent = Dir::open_ambient_dir(parent, ambient_authority()).map_err(|error| {
                format!("Could not open the attachment download parent directory: {error}")
            })?;
            let expected_metadata = parent.symlink_metadata(file_name).map_err(|error| {
                format!("Could not inspect the attachment download destination directory: {error}")
            })?;
            if !expected_metadata.is_dir() {
                return Err(
                    "The attachment download destination parent must be a directory without symlinks."
                        .to_string(),
                );
            }
            let held = parent.open_dir_nofollow(file_name).map_err(|error| {
                format!(
                    "Could not securely open the attachment download destination directory: {error}"
                )
            })?;
            let held_metadata = held.dir_metadata().map_err(|error| {
                format!(
                    "Could not inspect the held attachment download destination directory: {error}"
                )
            })?;
            if !attachment_capability_metadata_matches(&expected_metadata, &held_metadata) {
                return Err(
                    "The attachment download destination directory changed while it was opened."
                        .to_string(),
                );
            }
            Ok((held, attachment_file_identity(&held_metadata)))
        }
        _ => {
            let held = Dir::open_ambient_dir(path, ambient_authority()).map_err(|error| {
                format!("Could not open the attachment download destination directory: {error}")
            })?;
            let held_metadata = held.dir_metadata().map_err(|error| {
                format!(
                    "Could not inspect the held attachment download destination directory: {error}"
                )
            })?;
            Ok((held, attachment_file_identity(&held_metadata)))
        }
    }
}

fn attachment_download_destination_is_inside_vault(
    vault_root: &Path,
    parent: &Path,
    file_name: &OsStr,
) -> bool {
    parent.join(file_name).starts_with(vault_root)
}

fn reject_attachment_download_vault_destination(
    vault_root: &Path,
    parent: &Path,
    file_name: &OsStr,
) -> Result<(), String> {
    if attachment_download_destination_is_inside_vault(vault_root, parent, file_name) {
        return Err(
            "Notes attachment downloads cannot replace files inside the Notes Vault.".to_string(),
        );
    }
    Ok(())
}

fn prepare_attachment_download_destination(
    vault_path: &str,
    path: &Path,
) -> Result<PreparedAttachmentDownloadDestination, String> {
    let file_name = path
        .file_name()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Notes attachment download destination must name a file.".to_string())?
        .to_os_string();
    let parent_path = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let canonical_parent = fs::canonicalize(parent_path).map_err(|error| {
        format!("Could not resolve the attachment download destination directory: {error}")
    })?;
    let vault_root = fs::canonicalize(vault_path)
        .map_err(|error| format!("Could not resolve the Notes Vault directory: {error}"))?;
    reject_attachment_download_vault_destination(&vault_root, &canonical_parent, &file_name)?;

    #[cfg(windows)]
    let ancestor_guards = hold_attachment_download_windows_ancestors(&canonical_parent)?;
    let (parent, parent_identity) = open_canonical_directory_nofollow(&canonical_parent)?;

    Ok(PreparedAttachmentDownloadDestination {
        parent,
        file_name,
        parent_path: canonical_parent,
        parent_identity,
        vault_root,
        #[cfg(windows)]
        _ancestor_guards: ancestor_guards,
    })
}

fn revalidate_attachment_download_destination_parent(
    destination: &PreparedAttachmentDownloadDestination,
) -> Result<(), String> {
    let current_identity = match fs::canonicalize(&destination.parent_path) {
        Ok(canonical_parent) => {
            reject_attachment_download_vault_destination(
                &destination.vault_root,
                &canonical_parent,
                &destination.file_name,
            )?;
            open_canonical_directory_nofollow(&canonical_parent)
                .map(|(_current, identity)| Some(identity))
                .unwrap_or(None)
        }
        Err(_) => None,
    };
    if current_identity == Some(destination.parent_identity) {
        return Ok(());
    }

    #[cfg(windows)]
    {
        return Err(
            "The attachment download destination directory changed while it was in use."
                .to_string(),
        );
    }
    #[cfg(not(windows))]
    {
        if attachment_download_identity_is_reachable_inside_vault(
            &destination.vault_root,
            destination.parent_identity,
        )? {
            return Err(
                "The attachment download destination directory changed and was relocated inside the Notes Vault."
                    .to_string(),
            );
        }
        Ok(())
    }
}

fn attachment_download_identity_is_reachable_inside_vault(
    vault_root: &Path,
    identity: CapabilityFileIdentity,
) -> Result<bool, String> {
    let mut stack = vec![vault_root.to_path_buf()];
    let mut scanned = 0_usize;
    while let Some(path) = stack.pop() {
        scanned = scanned
            .checked_add(1)
            .ok_or_else(|| "Could not scan the Notes Vault download boundary.".to_string())?;
        if scanned > MAX_ATTACHMENT_DOWNLOAD_RELOCATION_SCAN_ENTRIES {
            return Err(
                "Could not prove the attachment download destination stayed outside the Notes Vault."
                    .to_string(),
            );
        }
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            format!("Could not inspect the Notes Vault download boundary: {error}")
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let (_held, current_identity) = open_canonical_directory_nofollow(&path)?;
        if current_identity == identity {
            return Ok(true);
        }
        let entries = fs::read_dir(&path).map_err(|error| {
            format!("Could not scan the Notes Vault download boundary: {error}")
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                format!("Could not inspect the Notes Vault download boundary: {error}")
            })?;
            let file_type = entry.file_type().map_err(|error| {
                format!("Could not inspect the Notes Vault download boundary: {error}")
            })?;
            if file_type.is_dir() && !file_type.is_symlink() {
                stack.push(entry.path());
            }
        }
    }
    Ok(false)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AttachmentDownloadDestinationState {
    Missing,
    Existing(CapabilityFileIdentity),
}

fn attachment_download_destination_state(
    parent: &Dir,
    file_name: &OsStr,
) -> Result<AttachmentDownloadDestinationState, String> {
    match parent.symlink_metadata(Path::new(file_name)) {
        Ok(metadata) if metadata.file_type().is_file() => {
            #[cfg(windows)]
            if !attachment_download_windows_attributes_are_safe(
                cap_std::fs::MetadataExt::file_attributes(&metadata),
            ) {
                return Err(
                    "Notes attachment download destination must not be a Windows reparse point."
                        .to_string(),
                );
            }
            Ok(AttachmentDownloadDestinationState::Existing(
                attachment_file_identity(&metadata),
            ))
        }
        Ok(_) => Err(
            "Notes attachment download destination must be a regular file or a new file."
                .to_string(),
        ),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            Ok(AttachmentDownloadDestinationState::Missing)
        }
        Err(error) => Err(format!(
            "Could not inspect the Notes attachment download destination: {error}"
        )),
    }
}

fn validate_attachment_download_destination(parent: &Dir, file_name: &OsStr) -> Result<(), String> {
    attachment_download_destination_state(parent, file_name).map(|_| ())
}

struct AttachmentDownloadStaging {
    directory: Dir,
    #[cfg(windows)]
    directory_identity: CapabilityFileIdentity,
    file: cap_std::fs::File,
    file_identity: CapabilityFileIdentity,
    #[cfg(windows)]
    directory_path: PathBuf,
}

#[cfg(windows)]
fn create_private_attachment_download_staging_windows(path: &Path) -> io::Result<bool> {
    use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;

    let mut security =
        WindowsPrivateSecurityDescriptor::new(WINDOWS_ATTACHMENT_VIEW_DIRECTORY_ACE_FLAGS)
            .map_err(|error| io::Error::new(ErrorKind::PermissionDenied, error))?;
    let attributes = security.security_attributes();
    let path = attachment_download_windows_path(path)
        .map_err(|error| io::Error::new(ErrorKind::InvalidInput, error))?;
    if unsafe { CreateDirectoryW(path.as_ptr(), &attributes) } != 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.kind() == ErrorKind::AlreadyExists {
        Ok(false)
    } else {
        Err(error)
    }
}

fn validate_attachment_download_staging_security(directory: &Dir) -> Result<(), String> {
    #[cfg(unix)]
    {
        let metadata = directory.dir_metadata().map_err(|error| {
            format!("Could not inspect the attachment download staging directory: {error}")
        })?;
        if CapUnixMetadataExt::uid(&metadata) != rustix::process::geteuid().as_raw()
            || CapUnixMetadataExt::mode(&metadata) & 0o777 != 0o700
        {
            return Err(
                "The attachment download staging directory must be private to its owner."
                    .to_string(),
            );
        }
        return Ok(());
    }
    #[cfg(windows)]
    {
        return validate_attachment_view_windows_root(directory).map_err(|error| {
            format!("The Windows attachment download staging directory is not private: {error}")
        });
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = directory;
        Ok(())
    }
}

fn create_attachment_download_staging(
    destination: &PreparedAttachmentDownloadDestination,
) -> Result<AttachmentDownloadStaging, String> {
    for _ in 0..64 {
        let sequence = ATTACHMENT_DOWNLOAD_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let directory_name = format!(
            "{ATTACHMENT_DOWNLOAD_TEMP_PREFIX}{timestamp:x}-{:x}-{sequence:x}",
            std::process::id()
        );
        #[cfg(windows)]
        let created = create_private_attachment_download_staging_windows(
            &destination.parent_path.join(&directory_name),
        );
        #[cfg(not(windows))]
        let created = {
            let mut builder = DirBuilder::new();
            #[cfg(unix)]
            CapDirBuilderExt::mode(&mut builder, 0o700);
            destination
                .parent
                .create_dir_with(&directory_name, &builder)
                .map(|()| true)
        };
        match created {
            Ok(true) => {}
            Ok(false) => continue,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Could not create a private attachment download staging directory: {error}"
                ))
            }
        }
        let directory = destination
            .parent
            .open_dir_nofollow(&directory_name)
            .map_err(|error| {
                format!("Could not open the attachment download staging directory: {error}")
            })?;
        validate_attachment_download_staging_security(&directory)?;
        let directory_metadata = directory.dir_metadata().map_err(|error| {
            format!("Could not inspect the attachment download staging directory: {error}")
        })?;
        if !directory_metadata.is_dir() {
            return Err("The attachment download staging path is not a directory.".to_string());
        }
        #[cfg(windows)]
        let directory_identity = attachment_file_identity(&directory_metadata);
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        #[cfg(unix)]
        CapOpenOptionsExt::mode(&mut options, 0o600);
        let file = directory
            .open_with(ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME, &options)
            .map_err(|error| {
                format!("Could not create an attachment download staged file: {error}")
            })?;
        let file_metadata = file.metadata().map_err(|error| {
            format!("Could not inspect an attachment download staged file: {error}")
        })?;
        if !file_metadata.is_file() || CapabilityMetadataExt::nlink(&file_metadata) != 1 {
            return Err(
                "The attachment download staged path must be one regular file.".to_string(),
            );
        }
        #[cfg(windows)]
        if !attachment_download_windows_attributes_are_safe(
            cap_std::fs::MetadataExt::file_attributes(&file_metadata),
        ) {
            return Err(
                "The attachment download staged file must not be a Windows reparse point."
                    .to_string(),
            );
        }
        return Ok(AttachmentDownloadStaging {
            directory,
            #[cfg(windows)]
            directory_identity,
            file_identity: attachment_file_identity(&file_metadata),
            file,
            #[cfg(windows)]
            directory_path: destination.parent_path.join(directory_name),
        });
    }
    Err("Could not allocate an attachment download staging directory.".to_string())
}

fn remove_attachment_download_temp(parent: &Dir, file_name: &str) -> Result<(), String> {
    #[cfg(windows)]
    let removal = remove_attachment_view_copy(parent, OsStr::new(file_name));
    #[cfg(not(windows))]
    let removal = parent.remove_file_or_symlink(file_name);
    match removal {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Could not remove an attachment download temporary file: {error}"
        )),
    }
}

fn remove_owned_attachment_download_temp(
    parent: &Dir,
    file_name: &str,
    identity: CapabilityFileIdentity,
) -> Result<(), String> {
    match parent.symlink_metadata(file_name) {
        Ok(metadata)
            if metadata.file_type().is_file()
                && attachment_file_identity(&metadata) == identity =>
        {
            remove_attachment_download_temp(parent, file_name)
        }
        Ok(_) => Err(
            "Refused to remove an attachment download temporary path after its identity changed."
                .to_string(),
        ),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Could not verify an attachment download temporary file before cleanup: {error}"
        )),
    }
}

fn validate_attachment_download_staging_child(
    staging: &AttachmentDownloadStaging,
) -> Result<(), String> {
    validate_attachment_download_staging_security(&staging.directory)?;
    let held_metadata = staging.file.metadata().map_err(|error| {
        format!("Could not inspect the held attachment download staged file: {error}")
    })?;
    let current_metadata = staging
        .directory
        .symlink_metadata(ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME)
        .map_err(|error| {
            format!("The attachment download staged source changed before publication: {error}")
        })?;
    if !held_metadata.is_file()
        || !current_metadata.file_type().is_file()
        || CapabilityMetadataExt::nlink(&held_metadata) != 1
        || CapabilityMetadataExt::nlink(&current_metadata) != 1
        || attachment_file_identity(&held_metadata) != staging.file_identity
        || attachment_file_identity(&current_metadata) != staging.file_identity
    {
        return Err(
            "The attachment download staged source changed before publication.".to_string(),
        );
    }
    #[cfg(windows)]
    if !attachment_download_windows_attributes_are_safe(cap_std::fs::MetadataExt::file_attributes(
        &current_metadata,
    )) {
        return Err(
            "The attachment download staged source changed before publication.".to_string(),
        );
    }
    Ok(())
}

#[cfg(windows)]
fn validate_attachment_download_windows_staging_path(
    destination: &PreparedAttachmentDownloadDestination,
    staging: &AttachmentDownloadStaging,
) -> Result<(), String> {
    let directory_name = staging
        .directory_path
        .file_name()
        .ok_or_else(|| "The Windows attachment download staging path is invalid.".to_string())?;
    let reopened = destination
        .parent
        .open_dir_nofollow(directory_name)
        .map_err(|error| {
            format!("The Windows attachment download staging path changed: {error}")
        })?;
    let metadata = reopened.dir_metadata().map_err(|error| {
        format!("Could not inspect the Windows attachment download staging path: {error}")
    })?;
    if attachment_file_identity(&metadata) != staging.directory_identity {
        return Err("The Windows attachment download staging path changed.".to_string());
    }
    validate_attachment_download_staging_security(&reopened)
}

fn cleanup_attachment_download_staging(staging: AttachmentDownloadStaging) -> Result<(), String> {
    let child_cleanup = remove_owned_attachment_download_temp(
        &staging.directory,
        ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME,
        staging.file_identity,
    );
    drop(staging.file);
    child_cleanup?;
    staging.directory.remove_open_dir().map_err(|error| {
        format!("Could not remove the attachment download staging directory: {error}")
    })
}

fn attachment_download_error_after_staging_cleanup(
    staging: AttachmentDownloadStaging,
    error: String,
) -> String {
    match cleanup_attachment_download_staging(staging) {
        Ok(()) => error,
        Err(cleanup_error) => format!("{error}; additionally, {cleanup_error}"),
    }
}

#[cfg(unix)]
fn sync_attachment_download_parent(parent: &Dir) -> Result<(), String> {
    parent
        .try_clone()
        .and_then(|parent| parent.into_std_file().sync_all())
        .map_err(|error| format!("Could not sync the attachment download directory: {error}"))
}

#[cfg(not(unix))]
fn sync_attachment_download_parent(_parent: &Dir) -> Result<(), String> {
    Ok(())
}

fn validate_attachment_download_publication_preconditions(
    destination: &PreparedAttachmentDownloadDestination,
    staging: &AttachmentDownloadStaging,
    expected: AttachmentDownloadDestinationState,
) -> Result<(), String> {
    revalidate_attachment_download_destination_parent(destination)?;
    let current =
        attachment_download_destination_state(&destination.parent, &destination.file_name)?;
    if current != expected {
        return Err(
            "The attachment download destination changed before atomic publication.".to_string(),
        );
    }
    #[cfg(windows)]
    validate_attachment_download_windows_staging_path(destination, staging)?;
    validate_attachment_download_staging_child(staging)?;
    Ok(())
}

#[cfg(any(
    target_os = "android",
    target_os = "ios",
    target_os = "linux",
    target_os = "macos"
))]
fn rename_attachment_download_with(
    old_parent: &Dir,
    old_name: &OsStr,
    new_parent: &Dir,
    new_name: &OsStr,
    flags: rustix::fs::RenameFlags,
) -> Result<(), String> {
    rustix::fs::renameat_with(old_parent, old_name, new_parent, new_name, flags)
        .map_err(|error| format!("Could not publish the attachment download: {error}"))
}

#[cfg(any(
    target_os = "android",
    target_os = "ios",
    target_os = "linux",
    target_os = "macos"
))]
fn rollback_attachment_download_exchange(
    destination: &PreparedAttachmentDownloadDestination,
    staging: &AttachmentDownloadStaging,
    temp_identity: CapabilityFileIdentity,
) -> Result<(), String> {
    if attachment_download_destination_state(&destination.parent, &destination.file_name)?
        != AttachmentDownloadDestinationState::Existing(temp_identity)
    {
        return Err(
            "Refused to roll back an attachment download after the published path changed."
                .to_string(),
        );
    }
    let displaced_identity = match attachment_download_destination_state(
        &staging.directory,
        OsStr::new(ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME),
    )? {
        AttachmentDownloadDestinationState::Existing(identity) => identity,
        AttachmentDownloadDestinationState::Missing => {
            return Err(
                "Refused to roll back an attachment download without one safe displaced file."
                    .to_string(),
            )
        }
    };
    rename_attachment_download_with(
        &destination.parent,
        &destination.file_name,
        &staging.directory,
        OsStr::new(ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME),
        rustix::fs::RenameFlags::EXCHANGE,
    )
    .map_err(|error| format!("Could not roll back the attachment download publication: {error}"))?;
    if attachment_download_destination_state(&destination.parent, &destination.file_name)?
        != AttachmentDownloadDestinationState::Existing(displaced_identity)
        || attachment_download_destination_state(
            &staging.directory,
            OsStr::new(ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME),
        )? != AttachmentDownloadDestinationState::Existing(temp_identity)
    {
        return Err("The attachment download changed during rollback.".to_string());
    }
    Ok(())
}

#[cfg(any(
    target_os = "android",
    target_os = "ios",
    target_os = "linux",
    target_os = "macos"
))]
fn publish_attachment_download_unix(
    destination: &PreparedAttachmentDownloadDestination,
    staging: &AttachmentDownloadStaging,
    expected: AttachmentDownloadDestinationState,
) -> Result<(), String> {
    let temp_identity = staging.file_identity;
    match expected {
        AttachmentDownloadDestinationState::Missing => {
            rename_attachment_download_with(
                &staging.directory,
                OsStr::new(ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME),
                &destination.parent,
                &destination.file_name,
                rustix::fs::RenameFlags::NOREPLACE,
            )?;
            if attachment_download_destination_state(&destination.parent, &destination.file_name)?
                != AttachmentDownloadDestinationState::Existing(temp_identity)
            {
                return Err(
                    "The attachment download destination changed during atomic publication."
                        .to_string(),
                );
            }
            if let Err(error) = revalidate_attachment_download_destination_parent(destination) {
                let rollback = if attachment_download_destination_state(
                    &destination.parent,
                    &destination.file_name,
                )? == AttachmentDownloadDestinationState::Existing(temp_identity)
                {
                    rename_attachment_download_with(
                        &destination.parent,
                        &destination.file_name,
                        &staging.directory,
                        OsStr::new(ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME),
                        rustix::fs::RenameFlags::NOREPLACE,
                    )
                } else {
                    Err("Refused to roll back after the published path changed.".to_string())
                };
                return match rollback {
                    Ok(()) => Err(error),
                    Err(rollback_error) => Err(format!(
                        "{error}; additionally, could not roll back publication: {rollback_error}"
                    )),
                };
            }
        }
        AttachmentDownloadDestinationState::Existing(expected_identity) => {
            maybe_inject_attachment_download_before_existing_publication()?;
            rename_attachment_download_with(
                &staging.directory,
                OsStr::new(ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME),
                &destination.parent,
                &destination.file_name,
                rustix::fs::RenameFlags::EXCHANGE,
            )?;
            let displaced = attachment_download_destination_state(
                &staging.directory,
                OsStr::new(ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME),
            );
            let published =
                attachment_download_destination_state(&destination.parent, &destination.file_name);
            let displaced_matches = displaced
                == Ok(AttachmentDownloadDestinationState::Existing(
                    expected_identity,
                ));
            let published_matches =
                published == Ok(AttachmentDownloadDestinationState::Existing(temp_identity));
            if !displaced_matches || !published_matches {
                let rollback =
                    rollback_attachment_download_exchange(destination, staging, temp_identity);
                return match rollback {
                    Ok(()) => Err(
                        "The attachment download destination changed during atomic publication."
                            .to_string(),
                    ),
                    Err(rollback_error) => Err(format!(
                        "The attachment download destination changed during atomic publication; {rollback_error}"
                    )),
                };
            }
            if let Err(error) = revalidate_attachment_download_destination_parent(destination) {
                let rollback =
                    rollback_attachment_download_exchange(destination, staging, temp_identity);
                return match rollback {
                    Ok(()) => Err(error),
                    Err(rollback_error) => Err(format!(
                        "{error}; additionally, could not roll back publication: {rollback_error}"
                    )),
                };
            }
            if attachment_download_destination_state(&destination.parent, &destination.file_name)?
                != AttachmentDownloadDestinationState::Existing(temp_identity)
                || attachment_download_destination_state(
                    &staging.directory,
                    OsStr::new(ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME),
                )? != AttachmentDownloadDestinationState::Existing(expected_identity)
            {
                return Err(
                    "The attachment download publication changed before displaced-file cleanup."
                        .to_string(),
                );
            }
            remove_owned_attachment_download_temp(
                &staging.directory,
                ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME,
                expected_identity,
            )?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn attachment_download_windows_path(path: &Path) -> Result<Vec<u16>, String> {
    use std::os::windows::ffi::OsStrExt;

    let mut wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
    if wide.iter().any(|value| *value == 0) {
        return Err("A Windows attachment download path contains an invalid NUL.".to_string());
    }
    wide.push(0);
    Ok(wide)
}

#[cfg(windows)]
fn replace_attachment_download_windows(
    replaced: &Path,
    replacement: &Path,
    backup: &Path,
) -> Result<(), String> {
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    let replaced = attachment_download_windows_path(replaced)?;
    let replacement = attachment_download_windows_path(replacement)?;
    let backup = attachment_download_windows_path(backup)?;
    let replaced = unsafe {
        ReplaceFileW(
            replaced.as_ptr(),
            replacement.as_ptr(),
            backup.as_ptr(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if replaced == 0 {
        return Err(format!(
            "Could not atomically replace the attachment download on Windows: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn rollback_attachment_download_windows(
    destination: &PreparedAttachmentDownloadDestination,
    staging: &AttachmentDownloadStaging,
) -> Result<(), String> {
    let temp_identity = staging.file_identity;
    if attachment_download_destination_state(&destination.parent, &destination.file_name)?
        != AttachmentDownloadDestinationState::Existing(temp_identity)
        || attachment_download_destination_state(
            &staging.directory,
            OsStr::new(ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME),
        )? != AttachmentDownloadDestinationState::Missing
    {
        return Err(
            "Refused to roll back a Windows attachment download after its paths changed."
                .to_string(),
        );
    }
    let displaced_identity = match attachment_download_destination_state(
        &staging.directory,
        OsStr::new(ATTACHMENT_DOWNLOAD_BACKUP_FILE_NAME),
    )? {
        AttachmentDownloadDestinationState::Existing(identity) => identity,
        AttachmentDownloadDestinationState::Missing => return Err(
            "Refused to roll back a Windows attachment download without one safe displaced file."
                .to_string(),
        ),
    };
    replace_attachment_download_windows(
        &destination.parent_path.join(&destination.file_name),
        &staging
            .directory_path
            .join(ATTACHMENT_DOWNLOAD_BACKUP_FILE_NAME),
        &staging
            .directory_path
            .join(ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME),
    )
    .map_err(|error| format!("Could not roll back the Windows attachment download: {error}"))?;
    if attachment_download_destination_state(
        &staging.directory,
        OsStr::new(ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME),
    )? != AttachmentDownloadDestinationState::Existing(temp_identity)
        || attachment_download_destination_state(&destination.parent, &destination.file_name)?
            != AttachmentDownloadDestinationState::Existing(displaced_identity)
    {
        return Err("The Windows attachment download changed during rollback.".to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn recover_attachment_download_windows_replace_failure(
    destination: &PreparedAttachmentDownloadDestination,
    staging: &AttachmentDownloadStaging,
    expected_identity: CapabilityFileIdentity,
    error: String,
) -> String {
    let temp_identity = staging.file_identity;
    let recovery = (|| {
        let destination_state =
            attachment_download_destination_state(&destination.parent, &destination.file_name)?;
        let temp_state = attachment_download_destination_state(
            &staging.directory,
            OsStr::new(ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME),
        )?;
        let backup_state = attachment_download_destination_state(
            &staging.directory,
            OsStr::new(ATTACHMENT_DOWNLOAD_BACKUP_FILE_NAME),
        )?;
        match (destination_state, temp_state, backup_state) {
            (
                AttachmentDownloadDestinationState::Existing(identity),
                AttachmentDownloadDestinationState::Missing,
                AttachmentDownloadDestinationState::Existing(_),
            ) if identity == temp_identity => {
                rollback_attachment_download_windows(destination, staging)
            }
            (
                AttachmentDownloadDestinationState::Missing,
                AttachmentDownloadDestinationState::Existing(identity),
                AttachmentDownloadDestinationState::Existing(backup_identity),
            ) if identity == temp_identity => {
                staging
                    .directory
                    .rename(
                        ATTACHMENT_DOWNLOAD_BACKUP_FILE_NAME,
                        &destination.parent,
                        Path::new(&destination.file_name),
                    )
                    .map_err(|rename_error| {
                        format!(
                            "Could not restore the displaced Windows destination: {rename_error}"
                        )
                    })?;
                if attachment_download_destination_state(
                    &destination.parent,
                    &destination.file_name,
                )? != AttachmentDownloadDestinationState::Existing(backup_identity)
                {
                    return Err(
                        "The displaced Windows destination changed during recovery.".to_string()
                    );
                }
                Ok(())
            }
            (
                AttachmentDownloadDestinationState::Existing(destination_identity),
                AttachmentDownloadDestinationState::Existing(staged_identity),
                AttachmentDownloadDestinationState::Missing,
            ) if destination_identity == expected_identity && staged_identity == temp_identity => {
                Ok(())
            }
            _ => Err(
                "Refused to alter ambiguous Windows replacement paths after publication failed."
                    .to_string(),
            ),
        }
    })();
    match recovery {
        Ok(()) => error,
        Err(recovery_error) => format!("{error}; additionally, {recovery_error}"),
    }
}

#[cfg(windows)]
fn publish_attachment_download_windows(
    destination: &PreparedAttachmentDownloadDestination,
    staging: &AttachmentDownloadStaging,
    expected: AttachmentDownloadDestinationState,
) -> Result<(), String> {
    let temp_identity = staging.file_identity;
    match expected {
        AttachmentDownloadDestinationState::Missing => {
            staging
                .directory
                .rename(
                    ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME,
                    &destination.parent,
                    Path::new(&destination.file_name),
                )
                .map_err(|error| {
                    format!(
                        "Could not publish a new attachment download without replacement: {error}"
                    )
                })?;
            if attachment_download_destination_state(&destination.parent, &destination.file_name)?
                != AttachmentDownloadDestinationState::Existing(temp_identity)
            {
                return Err(
                    "The Windows attachment download destination changed during publication."
                        .to_string(),
                );
            }
            if let Err(error) = revalidate_attachment_download_destination_parent(destination) {
                let rollback = if attachment_download_destination_state(
                    &destination.parent,
                    &destination.file_name,
                )? == AttachmentDownloadDestinationState::Existing(temp_identity)
                    && attachment_download_destination_state(
                        &staging.directory,
                        OsStr::new(ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME),
                    )? == AttachmentDownloadDestinationState::Missing
                {
                    destination.parent.rename(
                        Path::new(&destination.file_name),
                        &staging.directory,
                        ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME,
                    )
                } else {
                    Err(io::Error::new(
                        ErrorKind::Other,
                        "published path changed before rollback",
                    ))
                };
                return match rollback {
                    Ok(()) => Err(error),
                    Err(rollback_error) => Err(format!(
                        "{error}; additionally, could not roll back publication: {rollback_error}"
                    )),
                };
            }
        }
        AttachmentDownloadDestinationState::Existing(expected_identity) => {
            maybe_inject_attachment_download_before_existing_publication()?;
            if attachment_download_destination_state(
                &staging.directory,
                OsStr::new(ATTACHMENT_DOWNLOAD_BACKUP_FILE_NAME),
            )? != AttachmentDownloadDestinationState::Missing
            {
                return Err(
                    "Could not allocate a Windows attachment download replacement backup."
                        .to_string(),
                );
            }
            if let Err(error) = replace_attachment_download_windows(
                &destination.parent_path.join(&destination.file_name),
                &staging
                    .directory_path
                    .join(ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME),
                &staging
                    .directory_path
                    .join(ATTACHMENT_DOWNLOAD_BACKUP_FILE_NAME),
            ) {
                return Err(recover_attachment_download_windows_replace_failure(
                    destination,
                    staging,
                    expected_identity,
                    error,
                ));
            }
            let displaced = attachment_download_destination_state(
                &staging.directory,
                OsStr::new(ATTACHMENT_DOWNLOAD_BACKUP_FILE_NAME),
            );
            let published =
                attachment_download_destination_state(&destination.parent, &destination.file_name);
            let displaced_matches = displaced
                == Ok(AttachmentDownloadDestinationState::Existing(
                    expected_identity,
                ));
            let published_matches =
                published == Ok(AttachmentDownloadDestinationState::Existing(temp_identity));
            if !displaced_matches || !published_matches {
                let rollback = rollback_attachment_download_windows(destination, staging);
                return match rollback {
                    Ok(()) => Err(
                        "The Windows attachment download destination changed during atomic publication."
                            .to_string(),
                    ),
                    Err(rollback_error) => Err(format!(
                        "The Windows attachment download destination changed during atomic publication; {rollback_error}"
                    )),
                };
            }
            if let Err(error) = revalidate_attachment_download_destination_parent(destination) {
                let rollback = rollback_attachment_download_windows(destination, staging);
                return match rollback {
                    Ok(()) => Err(error),
                    Err(rollback_error) => Err(format!(
                        "{error}; additionally, could not roll back publication: {rollback_error}"
                    )),
                };
            }
            if attachment_download_destination_state(&destination.parent, &destination.file_name)?
                != AttachmentDownloadDestinationState::Existing(temp_identity)
                || attachment_download_destination_state(
                    &staging.directory,
                    OsStr::new(ATTACHMENT_DOWNLOAD_BACKUP_FILE_NAME),
                )? != AttachmentDownloadDestinationState::Existing(expected_identity)
            {
                return Err(
                    "The Windows attachment download changed before displaced-file cleanup."
                        .to_string(),
                );
            }
            remove_owned_attachment_download_temp(
                &staging.directory,
                ATTACHMENT_DOWNLOAD_BACKUP_FILE_NAME,
                expected_identity,
            )?;
        }
    }
    Ok(())
}

fn publish_attachment_download(
    destination: &PreparedAttachmentDownloadDestination,
    staging: &AttachmentDownloadStaging,
    expected: AttachmentDownloadDestinationState,
) -> Result<(), String> {
    validate_attachment_download_publication_preconditions(destination, staging, expected)?;
    #[cfg(any(
        target_os = "android",
        target_os = "ios",
        target_os = "linux",
        target_os = "macos"
    ))]
    {
        return publish_attachment_download_unix(destination, staging, expected);
    }
    #[cfg(windows)]
    {
        return publish_attachment_download_windows(destination, staging, expected);
    }
    #[cfg(not(any(
        target_os = "android",
        target_os = "ios",
        target_os = "linux",
        target_os = "macos",
        windows
    )))]
    {
        let _ = (destination, staging, expected);
        Err(
            "Secure atomic attachment download publication is unsupported on this platform."
                .to_string(),
        )
    }
}

fn write_attachment_download_atomic(
    destination: &PreparedAttachmentDownloadDestination,
    bytes: &[u8],
    expected: AttachmentDownloadDestinationState,
    before_publish: impl FnOnce() -> Result<(), String>,
    after_final_validation: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let mut staging = create_attachment_download_staging(destination)?;
    let write_result = (|| {
        staging
            .file
            .write_all(bytes)
            .map_err(|error| format!("Could not write the attachment download: {error}"))?;
        staging
            .file
            .sync_all()
            .map_err(|error| format!("Could not sync the attachment download: {error}"))?;
        sync_attachment_download_parent(&staging.directory)
    })();
    if let Err(error) = write_result {
        return Err(attachment_download_error_after_staging_cleanup(
            staging, error,
        ));
    }

    let publish_result = (|| {
        before_publish()?;
        revalidate_attachment_download_destination_parent(destination)?;
        after_final_validation()?;
        publish_attachment_download(destination, &staging, expected)
    })();
    if let Err(error) = publish_result {
        return Err(attachment_download_error_after_staging_cleanup(
            staging, error,
        ));
    }

    cleanup_attachment_download_staging(staging)?;
    let _ = sync_attachment_download_parent(&destination.parent);
    Ok(())
}

#[derive(Clone)]
struct AttachmentDownloadSourceIdentity {
    vault_storage: VaultStorageIdentity,
    attachment: NoteAttachment,
}

fn capture_attachment_download_source(
    vault_path: &str,
    attachment_id: &str,
) -> Result<AttachmentDownloadSourceIdentity, String> {
    let storage = AttachmentStorageLease::acquire(vault_path)?;
    let shared = acquire_notes_connection(vault_path)?;
    let connection = lock_notes_connection(&shared)?;
    let vault_storage = capture_validated_attachment_database_identity(&storage, &connection)?;
    let attachment = attachment_by_id(&connection, attachment_id)?
        .ok_or_else(|| format!("Notes attachment {attachment_id} does not exist."))?;
    Ok(AttachmentDownloadSourceIdentity {
        vault_storage,
        attachment,
    })
}

fn validate_attachment_download_source(
    storage: &AttachmentStorageLease,
    vault_path: &str,
    expected: &AttachmentDownloadSourceIdentity,
) -> Result<NoteAttachment, String> {
    storage.validate_identity(&expected.vault_storage)?;
    let shared = acquire_notes_connection(vault_path)?;
    let connection = lock_notes_connection(&shared)?;
    let current = attachment_by_id(&connection, &expected.attachment.id)?
        .ok_or_else(|| "The Notes attachment changed while choosing a destination.".to_string())?;
    if current != expected.attachment {
        return Err("The Notes attachment changed while choosing a destination.".to_string());
    }
    Ok(current)
}

struct AttachmentDownloadDialogSpec {
    default_file_name: String,
    filter_name: &'static str,
    extensions: &'static [&'static str],
    source: AttachmentDownloadSourceIdentity,
}

fn attachment_download_dialog_spec(
    vault_path: &str,
    attachment_id: &str,
) -> Result<AttachmentDownloadDialogSpec, String> {
    let source = capture_attachment_download_source(vault_path, attachment_id)?;
    let attachment = &source.attachment;
    let (filter_name, extensions): (&'static str, &'static [&'static str]) =
        match attachment.mime_type.as_str() {
            "image/png" => ("PNG image", &["png"]),
            "image/jpeg" => ("JPEG image", &["jpg", "jpeg"]),
            "image/webp" => ("WebP image", &["webp"]),
            "image/gif" => ("GIF image", &["gif"]),
            _ => return Err("The Notes attachment MIME type is unsupported.".to_string()),
        };
    let extension = canonical_attachment_extension(&attachment.mime_type)?;
    let suffix = format!(".{extension}");
    let max_stem_bytes = 255_usize
        .checked_sub(suffix.len())
        .ok_or_else(|| "The Notes attachment download filename is too long.".to_string())?;
    let safe_stem = safe_attachment_view_stem(&attachment.original_name);
    let safe_stem = truncate_utf8_to_bytes(&safe_stem, max_stem_bytes);
    let safe_stem = if safe_stem.is_empty() {
        "image"
    } else {
        safe_stem
    };
    let safe_stem = if windows_reserved_device_stem(safe_stem) {
        format!("_{safe_stem}")
    } else {
        safe_stem.to_string()
    };
    Ok(AttachmentDownloadDialogSpec {
        default_file_name: format!("{safe_stem}{suffix}"),
        filter_name,
        extensions,
        source,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_download_attachment(
    app: tauri::AppHandle,
    vault_path: String,
    attachment_id: String,
) -> Result<(), NotesError> {
    run_blocking(move || {
        let spec = attachment_download_dialog_spec(&vault_path, &attachment_id)?;
        let selected = app
            .dialog()
            .file()
            .set_file_name(spec.default_file_name)
            .add_filter(spec.filter_name, spec.extensions)
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(());
        };
        let destination_path = selected.into_path().map_err(|error| {
            format!("Could not resolve the attachment download destination: {error}")
        })?;
        notes_download_attachment_with_source_and_hooks(
            vault_path,
            spec.source,
            destination_path,
            || Ok(()),
            || Ok(()),
            || Ok(()),
        )
    })
    .await
}

#[cfg(test)]
pub(crate) fn notes_download_attachment_inner(
    vault_path: String,
    attachment_id: String,
    destination_path: String,
) -> Result<(), String> {
    notes_download_attachment_path_inner(vault_path, attachment_id, PathBuf::from(destination_path))
}

#[cfg(test)]
fn notes_download_attachment_path_inner(
    vault_path: String,
    attachment_id: String,
    destination_path: PathBuf,
) -> Result<(), String> {
    notes_download_attachment_with_hooks(
        vault_path,
        attachment_id,
        destination_path,
        || Ok(()),
        || Ok(()),
        || Ok(()),
    )
}

#[cfg(test)]
fn notes_download_attachment_with_hooks(
    vault_path: String,
    attachment_id: String,
    destination_path: impl Into<PathBuf>,
    after_parent_open: impl FnOnce() -> Result<(), String>,
    before_publish: impl FnOnce() -> Result<(), String>,
    after_final_validation: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let source = capture_attachment_download_source(&vault_path, &attachment_id)?;
    notes_download_attachment_with_source_and_hooks(
        vault_path,
        source,
        destination_path,
        after_parent_open,
        before_publish,
        after_final_validation,
    )
}

fn notes_download_attachment_with_source_and_hooks(
    vault_path: String,
    source: AttachmentDownloadSourceIdentity,
    destination_path: impl Into<PathBuf>,
    after_parent_open: impl FnOnce() -> Result<(), String>,
    before_publish: impl FnOnce() -> Result<(), String>,
    after_final_validation: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let destination_path = destination_path.into();
    let destination = prepare_attachment_download_destination(&vault_path, &destination_path)?;
    let result = (|| {
        after_parent_open()?;
        revalidate_attachment_download_destination_parent(&destination)?;
        validate_attachment_download_destination(&destination.parent, &destination.file_name)?;
        let expected =
            attachment_download_destination_state(&destination.parent, &destination.file_name)?;
        let storage = AttachmentStorageLease::acquire(&vault_path)?;
        let attachment = validate_attachment_download_source(&storage, &vault_path, &source)?;
        let bytes = storage.read_validated_attachment_bytes(&attachment)?;
        validate_attachment_download_source(&storage, &vault_path, &source)?;
        let write_result = write_attachment_download_atomic(
            &destination,
            &bytes,
            expected,
            || {
                validate_attachment_download_source(&storage, &vault_path, &source)?;
                before_publish()
            },
            after_final_validation,
        );
        drop(storage);
        write_result
    })();
    result
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
        let connection = lock_notes_connection(&shared)?;
        attachment_by_id(&connection, &attachment_id)?
            .ok_or_else(|| format!("Notes attachment {attachment_id} does not exist."))?
    };
    storage.read_validated_attachment_bytes(&attachment)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_resize_attachment(
    vault_path: String,
    input: ResizeAttachmentInput,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_resize_attachment_inner(vault_path, input, history_context)).await
}

pub(crate) fn notes_resize_attachment_inner(
    vault_path: String,
    input: ResizeAttachmentInput,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        resize_attachment(connection, &input.id, input.display_width)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_remove_attachment(
    vault_path: String,
    attachment_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_remove_attachment_inner(vault_path, attachment_id, history_context))
        .await
}

pub(crate) fn notes_remove_attachment_inner(
    vault_path: String,
    attachment_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, String> {
    run_mutation(&vault_path, history_context, |connection| {
        remove_attachment(connection, &attachment_id)
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_restore_attachment(
    vault_path: String,
    attachment_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, NotesError> {
    run_blocking(move || notes_restore_attachment_inner(vault_path, attachment_id, history_context))
        .await
}

pub(crate) fn notes_restore_attachment_inner(
    vault_path: String,
    attachment_id: String,
    history_context: NotesHistoryContext,
) -> Result<NotesMutationResult, String> {
    let storage = AttachmentStorageLease::acquire(&vault_path)?;
    let shared = acquire_notes_connection(&vault_path)?;
    let mut connection = lock_notes_connection(&shared)?;
    let attachment = removed_attachment_snapshot(&connection, &attachment_id)?;
    storage.read_validated_attachment_bytes(&attachment)?;
    match with_history_transaction_and_prunes(
        &mut connection,
        Some(&history_context),
        |connection| restore_attachment(connection, attachment),
    ) {
        Ok(result) => {
            validate_notes_connection(&connection)?;
            reconcile_after_committed_attachment_change(&storage, &connection);
            validate_notes_connection(&connection)?;
            Ok(result.into_mutation_result())
        }
        Err(error) => Err(attachment_metadata_error(&storage, &connection, error)),
    }
}

#[cfg(test)]
pub(crate) fn notes_resize_attachment_with_optional_history_context_for_test(
    vault_path: String,
    input: ResizeAttachmentInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_mutation_with_optional_history_context_for_test(
        &vault_path,
        history_context,
        |connection| resize_attachment(connection, &input.id, input.display_width),
    )
}

#[cfg(test)]
pub(crate) fn notes_remove_attachment_with_optional_history_context_for_test(
    vault_path: String,
    attachment_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    run_mutation_with_optional_history_context_for_test(
        &vault_path,
        history_context,
        |connection| remove_attachment(connection, &attachment_id),
    )
}

#[cfg(test)]
pub(crate) fn notes_restore_attachment_with_optional_history_context_for_test(
    vault_path: String,
    attachment_id: String,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String> {
    let storage = AttachmentStorageLease::acquire(&vault_path)?;
    let shared = acquire_notes_connection(&vault_path)?;
    let mut connection = lock_notes_connection(&shared)?;
    let attachment = removed_attachment_snapshot(&connection, &attachment_id)?;
    storage.read_validated_attachment_bytes(&attachment)?;
    let result = match history_context.as_ref() {
        Some(context) => {
            with_history_transaction_and_prunes(&mut connection, Some(context), |connection| {
                restore_attachment(connection, attachment)
            })
        }
        None => with_untracked_transaction_and_prunes_for_test(&mut connection, |connection| {
            restore_attachment(connection, attachment)
        }),
    };
    match result {
        Ok(result) => {
            validate_notes_connection(&connection)?;
            reconcile_after_committed_attachment_change(&storage, &connection);
            validate_notes_connection(&connection)?;
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
    let connection = lock_notes_connection(&shared)?;
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
    let connection = lock_notes_connection(&shared)?;
    search_nodes_structured(&connection, &query)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_list_tags(vault_path: String) -> Result<Vec<String>, NotesError> {
    run_blocking(move || notes_list_tags_inner(vault_path)).await
}

pub(crate) fn notes_list_tags_inner(vault_path: String) -> Result<Vec<String>, String> {
    let shared = acquire_notes_connection(&vault_path)?;
    let connection = lock_notes_connection(&shared)?;
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
    let connection = lock_notes_connection(&shared)?;
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
    // Stop new DB users, drain current guards, and close the cached SQLite handle
    // before removing any member of the set. The gate remains held through asset
    // cleanup so no command can recreate the database mid-delete.
    let _deletion_guard = begin_notes_database_deletion(&vault_path)?;
    maybe_inject_delete_database_race(&vault_path);
    delete_database_from_metadata(storage.metadata_directory())?;
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
    acquire_existing_vault_app_lock(&vault_path)?;
    preflight_export_destinations_outside_vault_metadata(&vault_path, &[&destination_path])?;

    let connection = open_notes_export_db(&vault_path)?;
    let snapshot = load_export_snapshot(&connection, &root_node_id)?;
    let markdown_assets = if export_snapshot_has_attachments(&snapshot) {
        let destination = markdown_asset_destination(&destination_path)?;
        preflight_export_destinations_outside_vault_metadata(
            &vault_path,
            &[&destination_path, &destination.0],
        )?;
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
        let destination_guard = NotesExportDestinationGuard::acquire(
            &vault_path,
            &[&destination_path, &asset_destination],
        )?;
        maybe_inject_export_before_publication();
        publish_markdown_export_guarded(
            &destination_path,
            &asset_destination,
            &prepared,
            overwrite,
            &destination_guard,
            maybe_inject_export_after_final_revalidation,
        )?;
    } else {
        let bytes = render_markdown(&snapshot)?;
        let destination_guard =
            NotesExportDestinationGuard::acquire(&vault_path, &[&destination_path])?;
        maybe_inject_export_before_publication();
        destination_guard.write_atomic_file(
            &destination_path,
            &bytes,
            overwrite,
            maybe_inject_export_after_final_revalidation,
        )?;
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
    acquire_existing_vault_app_lock(&vault_path)?;
    preflight_export_destinations_outside_vault_metadata(&vault_path, &[&destination_path])?;

    let connection = open_notes_export_db(&vault_path)?;
    let snapshot = load_export_snapshot(&connection, &root_node_id)?;
    let snapshot =
        hydrate_export_snapshot_if_needed(&vault_path, &connection, &root_node_id, snapshot)?;
    let bytes = renderer(&snapshot)?;
    let destination_guard =
        NotesExportDestinationGuard::acquire(&vault_path, &[&destination_path])?;
    maybe_inject_export_before_publication();
    destination_guard.write_atomic_file(
        &destination_path,
        &bytes,
        overwrite,
        maybe_inject_export_after_final_revalidation,
    )?;

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
        notes_apply_batch_with_optional_history_context_for_test as notes_apply_batch,
        notes_archive_node_with_optional_history_context_for_test as notes_archive_node,
        notes_clear_history_legacy_inner as notes_clear_history,
        notes_collapse_all_with_optional_history_context_for_test as notes_collapse_all,
        notes_create_node_with_optional_history_context_for_test as notes_create_node,
        notes_delete_database_inner as notes_delete_database,
        notes_download_attachment_inner as notes_download_attachment,
        notes_duplicate_node_with_optional_history_context_for_test as notes_duplicate_node,
        notes_empty_trash_legacy_inner as notes_empty_trash,
        notes_expand_all_with_optional_history_context_for_test as notes_expand_all,
        notes_export_markdown_inner as notes_export_markdown,
        notes_export_pdf_inner as notes_export_pdf,
        notes_history_status_inner as notes_history_status,
        notes_import_attachment_paths_batch_with_optional_history_context_for_test as notes_import_attachment_paths_batch,
        notes_import_attachment_with_optional_history_context_for_test as notes_import_attachment,
        notes_import_image_node_paths_batch_with_optional_history_context_for_test as notes_import_image_node_paths_batch,
        notes_initialize_inner as notes_initialize, notes_list_tags_inner as notes_list_tags,
        notes_list_tags_with_counts_inner as notes_list_tags_with_counts,
        notes_load_workspace_inner as notes_load_workspace,
        notes_move_node_with_optional_history_context_for_test as notes_move_node,
        notes_read_attachment_bytes_inner as notes_read_attachment_bytes,
        notes_redo_legacy_inner as notes_redo,
        notes_remove_attachment_with_optional_history_context_for_test as notes_remove_attachment,
        notes_remove_empty_node_with_optional_history_context_for_test as notes_remove_empty_node,
        notes_restore_node_with_optional_history_context_for_test as notes_restore_node,
        notes_search_inner as notes_search,
        notes_search_structured_inner as notes_search_structured,
        notes_soft_delete_node_with_optional_history_context_for_test as notes_soft_delete_node,
        notes_sort_subtree_ascending_with_optional_history_context_for_test as notes_sort_subtree_ascending,
        notes_sort_subtree_descending_with_optional_history_context_for_test as notes_sort_subtree_descending,
        notes_split_node_with_optional_history_context_for_test as notes_split_node,
        notes_toggle_collapsed_with_optional_history_context_for_test as notes_toggle_collapsed,
        notes_toggle_complete_with_optional_history_context_for_test as notes_toggle_complete,
        notes_toggle_star_with_optional_history_context_for_test as notes_toggle_star,
        notes_unarchive_node_with_optional_history_context_for_test as notes_unarchive_node,
        notes_undo_legacy_inner as notes_undo,
        notes_update_node_with_optional_history_context_for_test as notes_update_node,
    };
    use crate::notes::attachments::{
        inject_cleanup_failure, inject_full_reconciliation_after_quarantine_once,
        inject_full_reconciliation_after_remove_once, CleanupFailurePoint,
        MAX_ATTACHMENT_BATCH_BYTES, MAX_ATTACHMENT_BYTES,
    };
    use crate::notes::date_index::LocalDate;
    use crate::notes::types::{
        ApplyBatchInput, BatchOp, ImageAtomFocusResult, ImageAtomOperationLookup,
        ImageAtomOperationReceiptResult, ImportAttachmentInput, ImportAttachmentPathBatchInput,
        ImportAttachmentPathItem, ImportImageNodePathItem, ImportImageNodePathsInput,
        NoteAttachment, NoteLayoutMode, NoteNode, NoteNodeKind, NoteSearchMatchedField,
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

    fn initialize_empty_test_vault(vault_path: &str) {
        notes_initialize(vault_path.to_string()).expect("initialize test vault");
        let connection = connect_notes_db(vault_path).expect("open initialized test vault");
        connection
            .execute("DELETE FROM notes_nodes", [])
            .expect("remove onboarding fixture nodes");
    }

    const BATCH_A_ID: &str = "44444444-4444-4444-8444-444444444444";
    const BATCH_B_ID: &str = "55555555-5555-4555-8555-555555555555";
    const BATCH_C_ID: &str = "66666666-6666-4666-8666-666666666666";
    const BATCH_D_ID: &str = "77777777-7777-4777-8777-777777777777";
    const BATCH_MISSING_ID: &str = "99999999-9999-4999-8999-999999999999";
    const IMAGE_NODE_A_ID: &str = "88888888-8888-4888-8888-888888888881";
    const IMAGE_NODE_B_ID: &str = "88888888-8888-4888-8888-888888888882";
    const IMAGE_ATTACHMENT_A_ID: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddd01";
    const IMAGE_ATTACHMENT_B_ID: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddd02";

    fn seed_batch_node(
        vault_path: &str,
        id: &str,
        parent_id: Option<&str>,
        after_id: Option<&str>,
    ) {
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
            history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
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
        let shared = acquire_notes_connection(vault_path).expect("open vault for history count");
        let connection = lock_notes_connection(&shared).expect("lock vault for history count");
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

    #[cfg(unix)]
    fn install_replacement_sqlite_database(
        active_database: &Path,
        replacement_database: &Path,
        displaced_directory: &Path,
    ) {
        fs::create_dir(displaced_directory).expect("create displaced database directory");
        for suffix in ["", "-wal", "-shm"] {
            let mut source = active_database.as_os_str().to_os_string();
            source.push(suffix);
            let source = PathBuf::from(source);
            if source.exists() {
                let destination =
                    displaced_directory.join(source.file_name().expect("SQLite set file name"));
                fs::rename(source, destination).expect("move active SQLite set member");
            }
        }
        fs::copy(replacement_database, active_database)
            .expect("install replacement Notes database");
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
        let default_history_context = batch_history_context();
        let history_context =
            Some(history_context.unwrap_or(&default_history_context)).map(|context| {
                json!({
                    "sessionId": context.session_id,
                    "historyEpoch": context.history_epoch,
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

    #[cfg(unix)]
    #[test]
    fn attachment_identity_capture_rejects_a_same_generation_pathname_copy() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path = vault_path.to_string_lossy().into_owned();
        seed_attachment_batch_node(&vault_path);
        let shared = acquire_notes_connection(&vault_path).expect("acquire cached connection");
        {
            let connection =
                lock_notes_connection(&shared).expect("lock connection for checkpoint");
            connection
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .expect("checkpoint database before copying");
        }
        let database = crate::notes::repository::notes_db_path(&vault_path);
        let replacement = temp_dir.path().join("same-generation.sqlite");
        fs::copy(&database, &replacement).expect("copy same-generation main database");
        let moved_directory = database
            .parent()
            .expect("Notes metadata directory")
            .join("moved-before-attachment-capture");
        let raced_database = database.clone();
        inject_attachment_before_database_identity_capture_once(move || {
            fs::create_dir(&moved_directory).expect("create moved database directory");
            for suffix in ["", "-wal", "-shm"] {
                let mut source = raced_database.as_os_str().to_os_string();
                source.push(suffix);
                let source = PathBuf::from(source);
                if source.exists() {
                    let destination =
                        moved_directory.join(source.file_name().expect("SQLite set file name"));
                    fs::rename(source, destination).expect("move active SQLite set member");
                }
            }
            fs::copy(&replacement, &raced_database).expect("install same-generation database copy");
        });

        let storage = AttachmentStorageLease::acquire(&vault_path).expect("acquire storage lease");
        let connection = lock_notes_connection(&shared).expect("lock attachment connection");
        let result = capture_validated_attachment_database_identity(&storage, &connection);

        assert!(
            result.is_err(),
            "capture must reject a pathname identity from a different SQLite handle"
        );
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
            history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
            entry_id: REPLACEMENT_ENTRY_ID.to_string(),
            command_kind: "importAttachmentPaths".to_string(),
        }
    }

    fn image_node_history_context() -> NotesHistoryContext {
        NotesHistoryContext {
            session_id: SESSION_ID.to_string(),
            history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
            entry_id: REPLACEMENT_ENTRY_ID.to_string(),
            command_kind: "importImageNodes".to_string(),
        }
    }

    fn image_node_path_input(
        parent_id: Option<&str>,
        after_id: Option<&str>,
        first_source: &PathBuf,
        second_source: &PathBuf,
    ) -> ImportImageNodePathsInput {
        ImportImageNodePathsInput {
            parent_id: parent_id.map(str::to_string),
            after_id: after_id.map(str::to_string),
            items: vec![
                ImportImageNodePathItem {
                    node_id: IMAGE_NODE_A_ID.to_string(),
                    attachment_id: IMAGE_ATTACHMENT_A_ID.to_string(),
                    source_path: first_source.to_string_lossy().into_owned(),
                },
                ImportImageNodePathItem {
                    node_id: IMAGE_NODE_B_ID.to_string(),
                    attachment_id: IMAGE_ATTACHMENT_B_ID.to_string(),
                    source_path: second_source.to_string_lossy().into_owned(),
                },
            ],
            initial_max_display_width: 480,
        }
    }

    fn raw_image_node_envelope(
        vault_path: &str,
        parent_id: Option<&str>,
        after_id: Option<&str>,
        attachments: &[(&str, &str, &str, &str, &[u8])],
        history_context: Option<&NotesHistoryContext>,
    ) -> Vec<u8> {
        let history_context = history_context.map(|context| {
            json!({
                "sessionId": context.session_id,
                "historyEpoch": context.history_epoch,
                "entryId": context.entry_id,
                "commandKind": context.command_kind
            })
        });
        let metadata = json!({
            "vaultPath": vault_path,
            "parentId": parent_id,
            "afterId": after_id,
            "items": attachments
                .iter()
                .enumerate()
                .map(|(ordinal, (node_id, attachment_id, original_name, mime_type, bytes))| json!({
                    "nodeId": node_id,
                    "attachmentId": attachment_id,
                    "ordinal": ordinal,
                    "originalName": original_name,
                    "mimeType": mime_type,
                    "byteLength": bytes.len()
                }))
                .collect::<Vec<_>>(),
            "initialMaxDisplayWidth": 480,
            "historyContext": history_context
        });
        let metadata = serde_json::to_vec(&metadata).expect("encode raw image node metadata");
        let mut envelope = Vec::new();
        envelope.extend_from_slice(b"YNIB");
        envelope.push(2);
        envelope.extend_from_slice(
            &u32::try_from(metadata.len())
                .expect("raw image node metadata length")
                .to_le_bytes(),
        );
        envelope.extend_from_slice(&metadata);
        for (_, _, _, _, bytes) in attachments {
            envelope.extend_from_slice(bytes);
        }
        envelope
    }

    fn raw_attachment_boundary_envelope_with_metadata(
        vault_path: &str,
        original_name: &str,
        mime_type: &str,
        byte_lengths: &[u64],
        payload_bytes: usize,
    ) -> Vec<u8> {
        let history_context = batch_history_context();
        let metadata = json!({
            "vaultPath": vault_path,
            "nodeId": ROOT_ID,
            "attachments": byte_lengths
                .iter()
                .enumerate()
                .map(|(ordinal, byte_length)| json!({
                    "id": format!("90000000-0000-4000-8000-{ordinal:012x}"),
                    "ordinal": ordinal,
                    "originalName": original_name,
                    "mimeType": mime_type,
                    "byteLength": byte_length
                }))
                .collect::<Vec<_>>(),
            "initialMaxDisplayWidth": 480,
            "historyContext": {
                "sessionId": history_context.session_id,
                "historyEpoch": history_context.history_epoch,
                "entryId": history_context.entry_id,
                "commandKind": history_context.command_kind
            }
        });
        raw_boundary_envelope(b"YNAB", 1, metadata, payload_bytes)
    }

    fn raw_attachment_boundary_envelope(byte_lengths: &[u64], payload_bytes: usize) -> Vec<u8> {
        raw_attachment_boundary_envelope_with_metadata(
            "/tmp/raw-command-boundary",
            "attachment.png",
            "image/png",
            byte_lengths,
            payload_bytes,
        )
    }

    fn raw_image_node_boundary_envelope_with_metadata(
        vault_path: &str,
        original_name: &str,
        mime_type: &str,
        byte_lengths: &[u64],
        payload_bytes: usize,
        history_context: serde_json::Value,
    ) -> Vec<u8> {
        let metadata = json!({
            "vaultPath": vault_path,
            "parentId": null,
            "afterId": null,
            "items": byte_lengths
                .iter()
                .enumerate()
                .map(|(ordinal, byte_length)| json!({
                    "nodeId": format!("90000000-0000-4000-8000-{ordinal:012x}"),
                    "attachmentId": format!("a0000000-0000-4000-8000-{ordinal:012x}"),
                    "ordinal": ordinal,
                    "originalName": original_name,
                    "mimeType": mime_type,
                    "byteLength": byte_length
                }))
                .collect::<Vec<_>>(),
            "initialMaxDisplayWidth": 480,
            "historyContext": history_context
        });
        raw_boundary_envelope(b"YNIB", 2, metadata, payload_bytes)
    }

    fn raw_image_node_boundary_envelope_with_history(
        byte_lengths: &[u64],
        payload_bytes: usize,
        history_context: serde_json::Value,
    ) -> Vec<u8> {
        raw_image_node_boundary_envelope_with_metadata(
            "/tmp/raw-command-boundary",
            "image-node.png",
            "image/png",
            byte_lengths,
            payload_bytes,
            history_context,
        )
    }

    fn raw_image_node_boundary_envelope(byte_lengths: &[u64], payload_bytes: usize) -> Vec<u8> {
        let history_context = image_node_history_context();
        raw_image_node_boundary_envelope_with_history(
            byte_lengths,
            payload_bytes,
            json!({
                "sessionId": history_context.session_id,
                "historyEpoch": history_context.history_epoch,
                "entryId": history_context.entry_id,
                "commandKind": history_context.command_kind
            }),
        )
    }

    fn raw_boundary_envelope(
        magic: &[u8; 4],
        version: u8,
        metadata: serde_json::Value,
        payload_bytes: usize,
    ) -> Vec<u8> {
        let metadata = serde_json::to_vec(&metadata).expect("encode boundary metadata");
        let mut envelope = Vec::with_capacity(9 + metadata.len() + payload_bytes);
        envelope.extend_from_slice(magic);
        envelope.push(version);
        envelope.extend_from_slice(
            &u32::try_from(metadata.len())
                .expect("boundary metadata length")
                .to_le_bytes(),
        );
        envelope.extend_from_slice(&metadata);
        envelope.resize(envelope.len() + payload_bytes, 0);
        envelope
    }

    #[test]
    fn attachment_raw_command_rejects_invalid_envelopes_before_owned_copy() {
        for (label, body, expected) in [
            ("malformed", b"bad".to_vec(), "header is truncated"),
            (
                "oversized",
                raw_attachment_boundary_envelope(&[MAX_ATTACHMENT_BYTES; 4], 0),
                "67108864",
            ),
        ] {
            let copied = std::cell::Cell::new(false);
            let error = decode_and_own_raw_attachment_body_with(&body, |body| {
                copied.set(true);
                body.to_vec()
            })
            .expect_err(label);

            assert!(error.contains(expected), "{label}: {error}");
            assert!(!copied.get(), "{label} body was copied before rejection");
        }
    }

    #[test]
    fn image_node_raw_command_rejects_invalid_envelopes_before_owned_copy() {
        for (label, body, expected) in [
            ("malformed", b"bad".to_vec(), "header is truncated"),
            (
                "oversized",
                raw_image_node_boundary_envelope(&[MAX_ATTACHMENT_BYTES; 4], 0),
                "67108864",
            ),
        ] {
            let copied = std::cell::Cell::new(false);
            let error = decode_and_own_raw_image_node_body_with(&body, |body| {
                copied.set(true);
                body.to_vec()
            })
            .expect_err(label);

            assert!(error.contains(expected), "{label}: {error}");
            assert!(!copied.get(), "{label} body was copied before rejection");
        }
    }

    #[test]
    fn image_node_raw_command_rejects_required_history_before_owned_copy() {
        let item_bytes = MAX_ATTACHMENT_BATCH_BYTES / 4;
        let payload_bytes = usize::try_from(MAX_ATTACHMENT_BATCH_BYTES).expect("batch byte cap");
        for (label, history_context) in [
            ("missing", serde_json::Value::Null),
            (
                "invalid",
                json!({
                    "sessionId": SESSION_ID,
                    "entryId": "invalid",
                    "commandKind": "importImageNodes"
                }),
            ),
        ] {
            let body = raw_image_node_boundary_envelope_with_history(
                &[item_bytes; 4],
                payload_bytes,
                history_context,
            );
            assert!(body.len() > payload_bytes);
            let copied = std::cell::Cell::new(false);

            let error = decode_and_own_raw_image_node_body_with(&body, |_| {
                copied.set(true);
                Vec::new()
            })
            .expect_err(label);

            assert!(error.to_lowercase().contains("history"), "{label}: {error}");
            assert!(!copied.get(), "{label} body was copied before rejection");
        }
    }

    #[test]
    fn raw_import_waiter_does_not_occupy_the_only_blocking_worker() {
        use std::sync::{mpsc, Arc, Mutex};
        use std::time::Duration;

        let (task_tx, task_rx) = mpsc::channel::<RawImportPermitTestTask>();
        let worker = std::thread::spawn(move || {
            while let Ok(task) = task_rx.recv() {
                task();
            }
        });
        let (request_tx, request_rx) = mpsc::channel();
        *RAW_IMPORT_PERMIT_TEST_DISPATCH
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some(RawImportPermitTestDispatch {
                tasks: task_tx.clone(),
                requests: request_tx,
            });
        let continuation_tx = RAW_IMPORT_PERMIT_TEST_DISPATCH
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .expect("installed blocking worker")
            .tasks
            .clone();

        let first = tauri::async_runtime::block_on(acquire_import_permit_for_command())
            .expect("acquire first import permit");
        request_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("observe first admission request");
        let held = Arc::new(Mutex::new(Some(first)));

        let (waiter_tx, waiter_rx) = mpsc::channel();
        let waiter = std::thread::spawn(move || {
            let result = tauri::async_runtime::block_on(acquire_import_permit_for_command())
                .map(drop)
                .map_err(|error| format!("{error:?}"));
            waiter_tx.send(result).expect("send waiter result");
        });
        request_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("observe waiting admission request");

        let held_for_worker = Arc::clone(&held);
        let (release_tx, release_rx) = mpsc::channel();
        continuation_tx
            .send(Box::new(move || {
                drop(
                    held_for_worker
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .take(),
                );
                release_tx.send(()).expect("send holder continuation");
            }))
            .expect("queue holder continuation");

        let completed_within_bound = release_rx.recv_timeout(Duration::from_millis(250)).is_ok();
        if !completed_within_bound {
            drop(
                held.lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take(),
            );
            release_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("release worker after deadlock observation");
        }
        waiter_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("waiting admission completes")
            .expect("waiting admission succeeds");
        waiter.join().expect("join admission waiter");

        *RAW_IMPORT_PERMIT_TEST_DISPATCH
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        drop(continuation_tx);
        drop(task_tx);
        worker.join().expect("join single blocking worker");

        assert!(
            completed_within_bound,
            "an admission waiter occupied the only blocking worker and prevented the permit holder from continuing"
        );
    }

    #[test]
    fn raw_commands_reject_cheap_metadata_before_budget_or_owned_copy() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{mpsc, Arc};
        use std::time::Duration;

        let held_body = raw_attachment_boundary_envelope(&[1], 1);
        let mut held = Some(
            decode_and_own_raw_attachment_body_with(&held_body, <[u8]>::to_vec)
                .expect("hold raw import admission"),
        );
        let oversized_name = "x".repeat(1025);
        let history_context = image_node_history_context();
        let history_context = json!({
            "sessionId": history_context.session_id,
            "historyEpoch": history_context.history_epoch,
            "entryId": history_context.entry_id,
            "commandKind": history_context.command_kind
        });
        let item_bytes = MAX_ATTACHMENT_BATCH_BYTES / 4;
        let payload_bytes = usize::try_from(MAX_ATTACHMENT_BATCH_BYTES).expect("batch byte cap");
        let cases = vec![
            (
                "attachment empty vault",
                raw_attachment_boundary_envelope_with_metadata(
                    "",
                    "attachment.png",
                    "image/png",
                    &[item_bytes; 4],
                    payload_bytes,
                ),
                false,
                "Vault path",
            ),
            (
                "attachment empty name",
                raw_attachment_boundary_envelope_with_metadata(
                    "/tmp/raw-command-boundary",
                    " ",
                    "image/png",
                    &[1],
                    1,
                ),
                false,
                "original name",
            ),
            (
                "attachment oversized name",
                raw_attachment_boundary_envelope_with_metadata(
                    "/tmp/raw-command-boundary",
                    &oversized_name,
                    "image/png",
                    &[1],
                    1,
                ),
                false,
                "original name",
            ),
            (
                "attachment unsupported MIME",
                raw_attachment_boundary_envelope_with_metadata(
                    "/tmp/raw-command-boundary",
                    "attachment.png",
                    "image/svg+xml",
                    &[1],
                    1,
                ),
                false,
                "MIME type",
            ),
            (
                "image node empty vault",
                raw_image_node_boundary_envelope_with_metadata(
                    "",
                    "image-node.png",
                    "image/png",
                    &[1],
                    1,
                    history_context.clone(),
                ),
                true,
                "Vault path",
            ),
            (
                "image node empty name",
                raw_image_node_boundary_envelope_with_metadata(
                    "/tmp/raw-command-boundary",
                    " ",
                    "image/png",
                    &[1],
                    1,
                    history_context.clone(),
                ),
                true,
                "original name",
            ),
            (
                "image node oversized name",
                raw_image_node_boundary_envelope_with_metadata(
                    "/tmp/raw-command-boundary",
                    &oversized_name,
                    "image/png",
                    &[1],
                    1,
                    history_context.clone(),
                ),
                true,
                "original name",
            ),
            (
                "image node unsupported MIME",
                raw_image_node_boundary_envelope_with_metadata(
                    "/tmp/raw-command-boundary",
                    "image-node.png",
                    "image/svg+xml",
                    &[1],
                    1,
                    history_context,
                ),
                true,
                "MIME type",
            ),
        ];

        for (label, body, image_node, expected) in cases {
            let copied = Arc::new(AtomicBool::new(false));
            let copied_in_thread = Arc::clone(&copied);
            let (result_tx, result_rx) = mpsc::channel();
            let handle = std::thread::spawn(move || {
                let result = if image_node {
                    decode_and_own_raw_image_node_body_with(&body, |body| {
                        copied_in_thread.store(true, Ordering::SeqCst);
                        body.to_vec()
                    })
                    .map(|_| ())
                } else {
                    decode_and_own_raw_attachment_body_with(&body, |body| {
                        copied_in_thread.store(true, Ordering::SeqCst);
                        body.to_vec()
                    })
                    .map(|_| ())
                };
                result_tx.send(result).expect("send raw decode result");
            });
            let result = match result_rx.recv_timeout(Duration::from_secs(1)) {
                Ok(result) => result,
                Err(error) => {
                    drop(held.take());
                    handle.join().expect("join blocked raw decode");
                    panic!("{label} waited for import admission before validation: {error}");
                }
            };
            handle.join().expect("join raw decode");
            let error = result.expect_err(label);
            assert!(error.contains(expected), "{label}: {error}");
            assert!(!copied.load(Ordering::SeqCst), "{label} copied body");
        }

        drop(held);
    }

    #[test]
    fn raw_command_admission_moves_from_owned_body_to_prepared_batch() {
        use std::sync::mpsc;
        use std::time::Duration;

        let png = encoded_png(2, 2);
        let first_body = raw_attachment_envelope(
            "/tmp/raw-command-admission",
            &[(SPLIT_ID, "first.png", "image/png", &png)],
            None,
        );
        let first_owned = decode_and_own_raw_attachment_body_with(&first_body, <[u8]>::to_vec)
            .expect("own first raw body");
        let (_, first_prepared) =
            prepare_owned_raw_import(first_owned).expect("prepare first raw body");

        let second_body = raw_attachment_boundary_envelope(&[1], 1);
        let (copy_started_tx, copy_started_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        let second = std::thread::spawn(move || {
            let result = decode_and_own_raw_attachment_body_with(&second_body, |body| {
                copy_started_tx.send(()).expect("send copy start");
                body.to_vec()
            })
            .map(|_| ());
            result_tx.send(result).expect("send second raw result");
        });

        let copied_while_first_live = copy_started_rx
            .recv_timeout(Duration::from_millis(100))
            .is_ok();
        drop(first_prepared);
        if !copied_while_first_live {
            copy_started_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("second body copies after prepared batch drops");
        }
        result_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("second raw result")
            .expect("second raw decode");
        second.join().expect("join second raw decode");

        assert!(
            !copied_while_first_live,
            "a second raw body copied while prepared bytes retained admission"
        );
    }

    #[test]
    fn raw_command_admission_is_released_when_body_copy_panics() {
        let body = raw_attachment_boundary_envelope(&[1], 1);
        let panic = std::panic::catch_unwind(|| {
            let _ = decode_and_own_raw_attachment_body_with(&body, |_| -> Vec<u8> {
                panic!("injected raw body copy panic")
            });
        });
        assert!(panic.is_err(), "copy panic was not observed");

        let recovered = decode_and_own_raw_attachment_body_with(&body, <[u8]>::to_vec)
            .expect("raw admission recovers after copy panic");
        drop(recovered);
    }

    #[test]
    fn raw_command_admission_is_released_when_preparation_fails() {
        let invalid_image = [0_u8];
        let body = raw_attachment_envelope(
            "/tmp/raw-command-admission-error",
            &[(SPLIT_ID, "invalid.png", "image/png", &invalid_image)],
            None,
        );
        let owned = decode_and_own_raw_attachment_body_with(&body, <[u8]>::to_vec)
            .expect("own invalid raw image");
        let error = prepare_owned_raw_import(owned).expect_err("invalid image must fail");
        assert!(error.contains("invalid.png"), "{error}");

        let recovered = decode_and_own_raw_attachment_body_with(
            &raw_attachment_boundary_envelope(&[1], 1),
            <[u8]>::to_vec,
        )
        .expect("raw admission recovers after preparation error");
        drop(recovered);
    }

    #[test]
    fn notes_initialize_rejects_blank_vault_before_lock_or_storage() {
        const CHILD_ENV: &str = "YONALIST_BLANK_INITIALIZE_VAULT_CHILD";
        const TEST_NAME: &str =
            "notes::commands::tests::notes_initialize_rejects_blank_vault_before_lock_or_storage";

        if std::env::var_os(CHILD_ENV).is_some() {
            let cwd = std::env::current_dir().expect("isolated child cwd");
            let whitespace_vault = cwd.join(" \t ");

            for vault_path in ["", " \t "] {
                let error = notes_initialize(vault_path.to_string())
                    .expect_err("blank vault path must fail before initialization");
                assert_eq!(error, "Vault path must not be empty.");
            }

            assert!(!cwd.join(".yonalist").exists());
            assert!(!whitespace_vault.exists());
            return;
        }

        let isolated = tempfile::tempdir().expect("isolated child cwd");
        let output = std::process::Command::new(std::env::current_exe().expect("current test exe"))
            .arg(TEST_NAME)
            .arg("--exact")
            .arg("--nocapture")
            .env(CHILD_ENV, "1")
            .current_dir(isolated.path())
            .output()
            .expect("run isolated initialization regression");
        assert!(
            output.status.success(),
            "isolated initialization regression failed (created cwd metadata: {}, created whitespace vault: {}):\nstdout:\n{}\nstderr:\n{}",
            isolated.path().join(".yonalist").exists(),
            isolated.path().join(" \t ").exists(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        assert!(!isolated.path().join(".yonalist").exists());
        assert!(!isolated.path().join(" \t ").exists());
    }

    #[test]
    fn path_imports_reject_empty_vault_before_source_or_storage() {
        const CHILD_ENV: &str = "YONALIST_EMPTY_PATH_IMPORT_VAULT_CHILD";
        const TEST_NAME: &str =
            "notes::commands::tests::path_imports_reject_empty_vault_before_source_or_storage";

        if std::env::var_os(CHILD_ENV).is_some() {
            let cwd = std::env::current_dir().expect("isolated child cwd");
            let source = cwd.join("valid.png");
            let missing_source = cwd.join("missing.png");
            fs::write(&source, encoded_png(2, 2)).expect("write isolated image source");

            for vault_path in ["", " \t "] {
                let unread_attachment_error = notes_import_attachment_paths_batch(
                    vault_path.to_string(),
                    ImportAttachmentPathBatchInput {
                        node_id: ROOT_ID.to_string(),
                        attachments: vec![ImportAttachmentPathItem {
                            id: SPLIT_ID.to_string(),
                            source_path: missing_source.to_string_lossy().into_owned(),
                        }],
                        initial_max_display_width: 480,
                    },
                    None,
                )
                .expect_err("vault path must precede attachment source read");
                assert_eq!(unread_attachment_error, "Vault path must not be empty.");

                let attachment_error = notes_import_attachment_paths_batch(
                    vault_path.to_string(),
                    ImportAttachmentPathBatchInput {
                        node_id: ROOT_ID.to_string(),
                        attachments: vec![ImportAttachmentPathItem {
                            id: SPLIT_ID.to_string(),
                            source_path: source.to_string_lossy().into_owned(),
                        }],
                        initial_max_display_width: 480,
                    },
                    None,
                )
                .expect_err("empty attachment vault path");
                assert_eq!(attachment_error, "Vault path must not be empty.");
                assert!(!cwd.join(".yonalist").exists());

                let unread_image_error = notes_import_image_node_paths_batch(
                    vault_path.to_string(),
                    image_node_path_input(None, None, &missing_source, &missing_source),
                    Some(image_node_history_context()),
                )
                .expect_err("vault path must precede image source read");
                assert_eq!(unread_image_error, "Vault path must not be empty.");

                let image_error = notes_import_image_node_paths_batch(
                    vault_path.to_string(),
                    image_node_path_input(None, None, &source, &source),
                    Some(image_node_history_context()),
                )
                .expect_err("empty image node vault path");
                assert_eq!(image_error, "Vault path must not be empty.");
                assert!(!cwd.join(".yonalist").exists());
            }
            return;
        }

        let isolated = tempfile::tempdir().expect("isolated child cwd");
        let output = std::process::Command::new(std::env::current_exe().expect("current test exe"))
            .arg(TEST_NAME)
            .arg("--exact")
            .arg("--nocapture")
            .env(CHILD_ENV, "1")
            .current_dir(isolated.path())
            .output()
            .expect("run isolated path import regression");
        assert!(
            output.status.success(),
            "isolated path import regression failed (created .yonalist: {}):\nstdout:\n{}\nstderr:\n{}",
            isolated.path().join(".yonalist").exists(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        assert!(!isolated.path().join(".yonalist").exists());
    }

    #[test]
    fn raw_commands_allow_payload_limit_plus_envelope_overhead() {
        let item_bytes = MAX_ATTACHMENT_BATCH_BYTES / 4;
        let payload_bytes = usize::try_from(MAX_ATTACHMENT_BATCH_BYTES).expect("batch byte cap");

        {
            let body = raw_attachment_boundary_envelope(&[item_bytes; 4], payload_bytes);
            assert!(body.len() > payload_bytes);
            let copied_bytes = std::cell::Cell::new(0);

            decode_and_own_raw_attachment_body_with(&body, |body| {
                copied_bytes.set(body.len());
                Vec::new()
            })
            .expect("attachment payload at byte cap");

            assert_eq!(copied_bytes.get(), body.len());
        }

        {
            let body = raw_image_node_boundary_envelope(&[item_bytes; 4], payload_bytes);
            assert!(body.len() > payload_bytes);
            let copied_bytes = std::cell::Cell::new(0);

            decode_and_own_raw_image_node_body_with(&body, |body| {
                copied_bytes.set(body.len());
                Vec::new()
            })
            .expect("image node payload at byte cap");

            assert_eq!(copied_bytes.get(), body.len());
        }
    }

    fn assert_imported_image_node(
        workspace: &NotesWorkspace,
        node_id: &str,
        attachment_id: &str,
        parent_id: Option<&str>,
        title: &str,
    ) {
        let node = workspace
            .nodes
            .iter()
            .find(|node| node.id == node_id)
            .expect("imported image node");
        assert_eq!(node.node_kind, NoteNodeKind::Image);
        assert_eq!(node.parent_id.as_deref(), parent_id);
        assert_eq!(node.title, "");
        assert_eq!(node.note, "");
        assert_eq!(node.image_offset_utf16, 0);
        let attachments = workspace
            .attachments_by_node_id
            .get(node_id)
            .expect("image node attachment");
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].id, attachment_id);
        assert_eq!(attachments[0].node_id, node_id);
        assert_eq!(attachments[0].original_name, title);
    }

    fn assert_image_node_with_single_attachment<'a>(
        workspace: &'a NotesWorkspace,
        node_id: &str,
        title: &str,
        relative_path: &str,
    ) -> &'a NoteAttachment {
        let node = workspace
            .nodes
            .iter()
            .find(|node| node.id == node_id)
            .expect("image node");
        assert_eq!(node.node_kind, NoteNodeKind::Image);
        assert_eq!(node.title, "");
        assert_eq!(node.note, "");
        assert_eq!(node.image_offset_utf16, 0);
        let attachments = workspace
            .attachments_by_node_id
            .get(node_id)
            .expect("image node attachment");
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].node_id, node_id);
        assert_eq!(attachments[0].original_name, title);
        assert_eq!(attachments[0].relative_path, relative_path);
        &attachments[0]
    }

    fn attachment_row_count(vault_path: &str, attachment_id: &str) -> i64 {
        let connection = connect_notes_db(vault_path).expect("open attachment row database");
        connection
            .query_row(
                "SELECT COUNT(*) FROM notes_attachments WHERE id = ?1",
                [attachment_id],
                |row| row.get(0),
            )
            .expect("count attachment row")
    }

    fn node_row_count(vault_path: &str, node_id: &str) -> i64 {
        let connection = connect_notes_db(vault_path).expect("open node row database");
        connection
            .query_row(
                "SELECT COUNT(*) FROM notes_nodes WHERE id = ?1",
                [node_id],
                |row| row.get(0),
            )
            .expect("count node row")
    }

    fn attachment_count(vault_path: &str) -> i64 {
        let connection = connect_notes_db(vault_path).expect("open attachment count database");
        connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("count attachment rows")
    }

    fn attachment_history_change_count(vault_path: &str, attachment_id: &str) -> i64 {
        let shared =
            acquire_notes_connection(vault_path).expect("open attachment history database");
        let connection = lock_notes_connection(&shared).expect("lock attachment history database");
        connection
            .query_row(
                "SELECT COUNT(*) FROM notes_history_changes \
                 WHERE table_name = 'notes_attachments' AND row_id = ?1",
                [attachment_id],
                |row| row.get(0),
            )
            .expect("count attachment history changes")
    }

    fn owned_asset_path(vault_path: &str, relative_path: &str) -> PathBuf {
        crate::metadata_dir(vault_path).join(relative_path)
    }

    fn asset_file_name(relative_path: &str) -> String {
        Path::new(relative_path)
            .file_name()
            .expect("attachment relative path has file name")
            .to_string_lossy()
            .into_owned()
    }

    fn import_single_independent_raw_image_node(
        vault_path: &str,
        title: &str,
    ) -> (NotesMutationResult, crate::notes::types::NoteAttachment) {
        let png = encoded_png(4, 3);
        let context = image_node_history_context();
        let envelope = raw_image_node_envelope(
            vault_path,
            None,
            None,
            &[(
                IMAGE_NODE_A_ID,
                IMAGE_ATTACHMENT_A_ID,
                title,
                "image/png",
                &png,
            )],
            Some(&context),
        );

        let imported =
            notes_import_image_node_bytes_body(&envelope).expect("import raw image node");
        assert_imported_image_node(
            &imported.workspace,
            IMAGE_NODE_A_ID,
            IMAGE_ATTACHMENT_A_ID,
            None,
            title,
        );
        let attachment = imported.workspace.attachments_by_node_id[IMAGE_NODE_A_ID][0].clone();
        assert_eq!(attachment.id, IMAGE_ATTACHMENT_A_ID);
        assert_eq!(attachment.node_id, IMAGE_NODE_A_ID);
        (imported, attachment)
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

    fn seed_open_download_attachment(temp_dir: &tempfile::TempDir) -> (String, PathBuf, Vec<u8>) {
        seed_open_download_attachment_at(temp_dir, &temp_dir.path().join("vault"))
    }

    fn seed_open_download_attachment_at(
        temp_dir: &tempfile::TempDir,
        vault: &Path,
    ) -> (String, PathBuf, Vec<u8>) {
        let vault_path = vault.to_string_lossy().into_owned();
        seed_attachment_batch_node(&vault_path);
        let asset_path =
            import_export_attachment(temp_dir, &vault_path, SPLIT_ID, "Family Vacation.png");
        let bytes = fs::read(&asset_path).expect("read seeded attachment");
        (vault_path, asset_path, bytes)
    }

    #[test]
    fn attachment_download_dialog_prefixes_all_windows_reserved_device_names() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let connection = connect_notes_db(&vault_path).expect("open attachment database");
        for (original_name, expected) in [
            ("CON.png", "_CON.png"),
            ("com1.png", "_com1.png"),
            ("COM¹.png", "_COM¹.png"),
            ("lpt².png", "_lpt².png"),
            ("normal.png", "normal.png"),
        ] {
            connection
                .execute(
                    "UPDATE notes_attachments SET original_name = ?1 WHERE id = ?2",
                    params![original_name, SPLIT_ID],
                )
                .expect("set attachment filename");

            let spec = attachment_download_dialog_spec(&vault_path, SPLIT_ID)
                .expect("build native download dialog");

            assert_eq!(spec.default_file_name, expected);
            assert_eq!(spec.filter_name, "PNG image");
            assert_eq!(spec.extensions, &["png"]);
        }
    }

    #[test]
    fn attachment_download_windows_attributes_reject_the_reparse_bit() {
        assert!(attachment_download_windows_attributes_are_safe(0));
        assert!(!attachment_download_windows_attributes_are_safe(0x400));
        assert!(!attachment_download_windows_attributes_are_safe(0x420));
    }

    #[cfg(unix)]
    #[test]
    fn attachment_download_path_inner_never_lossily_redirects_non_utf8_dialog_selection() {
        use std::os::unix::ffi::OsStringExt;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, bytes) = seed_open_download_attachment(&temp_dir);
        let parent = temp_dir.path().join("download-parent");
        fs::create_dir(&parent).expect("create download parent");
        let destination = parent.join(OsString::from_vec(b"selected-\xff.png".to_vec()));
        let lossy_destination = parent.join("selected-�.png");
        fs::write(&lossy_destination, b"must remain unchanged")
            .expect("seed lossy sibling destination");

        let result = notes_download_attachment_path_inner(
            vault_path,
            SPLIT_ID.to_string(),
            destination.clone(),
        );

        assert_eq!(
            fs::read(&lossy_destination).expect("read lossy sibling"),
            b"must remain unchanged"
        );
        match result {
            Ok(()) => assert_eq!(fs::read(destination).expect("read native path"), bytes),
            Err(error) => {
                assert!(!destination.exists(), "failed download published a file");
                assert!(!error.is_empty());
            }
        }
    }

    fn assert_open_and_download_rejected(
        vault_path: &str,
        attachment_id: &str,
        temp_parent: &Path,
        destination: &Path,
    ) {
        let opener_called = std::cell::Cell::new(false);
        let open_error = notes_open_attachment_original_with_opener(
            vault_path.to_string(),
            attachment_id.to_string(),
            temp_parent,
            |_| {
                opener_called.set(true);
                Ok(())
            },
        )
        .expect_err("open original must reject invalid attachment");
        assert!(!open_error.is_empty());
        assert!(!opener_called.get());

        let download_error = notes_download_attachment(
            vault_path.to_string(),
            attachment_id.to_string(),
            destination.to_string_lossy().into_owned(),
        )
        .expect_err("download must reject invalid attachment");
        assert!(!download_error.is_empty());
    }

    #[test]
    fn attachment_open_download_success_uses_verified_bytes_without_notes_mutation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, bytes) = seed_open_download_attachment(&temp_dir);
        let temp_parent = temp_dir.path().join("system-temp");
        fs::create_dir(&temp_parent).expect("create system temp parent");
        let connection = connect_notes_db(&vault_path).expect("snapshot attachment metadata");
        let before = attachment_by_id(&connection, SPLIT_ID)
            .expect("read attachment")
            .expect("seeded attachment");
        drop(connection);
        let history_before = history_entry_count(&vault_path);
        let opened_paths = std::cell::RefCell::new(Vec::new());

        for _ in 0..2 {
            notes_open_attachment_original_with_opener(
                vault_path.clone(),
                SPLIT_ID.to_string(),
                &temp_parent,
                |path| {
                    assert!(!path.starts_with(Path::new(&vault_path)));
                    assert_eq!(
                        path.extension().and_then(|value| value.to_str()),
                        Some("png")
                    );
                    assert!(
                        path.file_name()
                            .and_then(|value| value.to_str())
                            .is_some_and(|name| name.contains("Family Vacation")),
                        "safe original basename was not preserved: {}",
                        path.display()
                    );
                    assert_eq!(fs::read(path).expect("read verified view copy"), bytes);
                    assert!(
                        fs::metadata(path)
                            .expect("view copy metadata")
                            .permissions()
                            .readonly(),
                        "view copy must be read-only before the opener runs"
                    );
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;

                        assert_eq!(
                            fs::metadata(path)
                                .expect("view copy Unix metadata")
                                .permissions()
                                .mode()
                                & 0o777,
                            0o400
                        );
                    }
                    opened_paths.borrow_mut().push(path.to_path_buf());
                    Ok(())
                },
            )
            .expect("open verified attachment copy");
        }

        let opened_paths = opened_paths.into_inner();
        assert_eq!(opened_paths.len(), 2);
        assert_ne!(opened_paths[0], opened_paths[1]);
        assert!(opened_paths.iter().all(|path| path.exists()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            assert_eq!(
                fs::metadata(temp_parent.join(ATTACHMENT_VIEW_ROOT_NAME))
                    .expect("view root Unix metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        #[cfg(windows)]
        {
            let root =
                open_existing_attachment_view_root(&temp_parent.join(ATTACHMENT_VIEW_ROOT_NAME))
                    .expect("open exact private Windows view root");
            validate_attachment_view_windows_root(&root)
                .expect("validate exact private Windows view-root ACL");
            for path in &opened_paths {
                let file = cap_std::fs::File::from_std(
                    fs::File::open(path).expect("open retained Windows view copy"),
                );
                validate_attachment_view_windows_copy(&file)
                    .expect("validate exact private Windows view-copy ACL");
            }
        }

        let destination = temp_dir.path().join("download.png");
        fs::write(&destination, b"old destination").expect("seed overwrite destination");
        notes_download_attachment(
            vault_path.clone(),
            SPLIT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
        )
        .expect("download verified attachment");
        assert_eq!(fs::read(&destination).expect("read download"), bytes);

        let connection = connect_notes_db(&vault_path).expect("re-read attachment metadata");
        let after = attachment_by_id(&connection, SPLIT_ID)
            .expect("read attachment after commands")
            .expect("attachment remains current");
        assert_eq!(after, before);
        assert_eq!(history_entry_count(&vault_path), history_before);
    }

    #[test]
    fn attachment_open_download_prepares_application_cache_parent() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let app_cache = temp_dir.path().join("per-user").join("application-cache");

        let prepared = prepare_attachment_view_parent(&app_cache)
            .expect("prepare per-user application cache parent");

        assert_eq!(
            prepared,
            fs::canonicalize(&app_cache).expect("canonical application cache parent")
        );
        assert!(prepared.is_dir());
        assert!(!prepared.join(ATTACHMENT_VIEW_ROOT_NAME).exists());
    }

    #[test]
    fn attachment_open_command_accepts_injected_app_handle() {
        fn compile_command_signature(
            app: tauri::AppHandle,
            vault_path: String,
            attachment_id: String,
        ) {
            std::mem::drop(notes_open_attachment_original(
                app,
                vault_path,
                attachment_id,
            ));
        }

        let _ = compile_command_signature as fn(tauri::AppHandle, String, String);
    }

    #[test]
    fn attachment_open_download_rejects_all_vault_view_root_overlaps() {
        for layout in ["equal", "vault-inside-root", "root-inside-vault"] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let outer = temp_dir.path();
            let (vault, temp_parent) = match layout {
                "equal" => (outer.join(ATTACHMENT_VIEW_ROOT_NAME), outer.to_path_buf()),
                "vault-inside-root" => (
                    outer.join(ATTACHMENT_VIEW_ROOT_NAME).join("vault"),
                    outer.to_path_buf(),
                ),
                "root-inside-vault" => {
                    let vault = outer.join("vault");
                    let temp_parent = vault.join("temporary");
                    (vault, temp_parent)
                }
                _ => unreachable!(),
            };
            let (vault_path, _asset_path, _bytes) =
                seed_open_download_attachment_at(&temp_dir, &vault);
            fs::create_dir_all(&temp_parent).expect("create overlap temp parent");
            let opener_called = std::cell::Cell::new(false);

            let error = notes_open_attachment_original_with_opener(
                vault_path,
                SPLIT_ID.to_string(),
                &temp_parent,
                |_| {
                    opener_called.set(true);
                    Ok(())
                },
            )
            .expect_err("Vault and view root overlap");

            assert!(
                error.to_lowercase().contains("overlap"),
                "{layout}: {error}"
            );
            assert!(!opener_called.get(), "{layout}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn attachment_open_download_rejects_precreated_nonprivate_view_root() {
        use std::os::unix::fs::PermissionsExt;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let temp_parent = temp_dir.path().join("system-temp");
        let root = temp_parent.join(ATTACHMENT_VIEW_ROOT_NAME);
        fs::create_dir(&temp_parent).expect("create temp parent");
        fs::create_dir(&root).expect("precreate view root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755))
            .expect("make view root nonprivate");
        let opener_called = std::cell::Cell::new(false);

        let error = notes_open_attachment_original_with_opener(
            vault_path,
            SPLIT_ID.to_string(),
            &temp_parent,
            |_| {
                opener_called.set(true);
                Ok(())
            },
        )
        .expect_err("nonprivate view root");

        assert!(error.to_lowercase().contains("private"), "{error}");
        assert!(!opener_called.get());
        assert!(fs::read_dir(root)
            .expect("inspect rejected view root")
            .next()
            .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn attachment_open_download_requires_exact_private_view_root_mode() {
        use std::os::unix::fs::PermissionsExt;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let root = temp_dir.path().join(ATTACHMENT_VIEW_ROOT_NAME);
        fs::create_dir(&root).expect("create view root");

        for mode in [0o300, 0o500, 0o701] {
            fs::set_permissions(&root, fs::Permissions::from_mode(mode))
                .expect("set rejected view-root mode");
            let result = open_existing_attachment_view_root(&root);
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .expect("restore private view-root mode");

            assert!(result.is_err(), "mode {mode:o} must be rejected");
        }

        open_existing_attachment_view_root(&root).expect("accept exact 0700 view-root mode");
    }

    #[cfg(unix)]
    #[test]
    fn attachment_open_download_rejects_view_root_owned_by_another_user() {
        use std::os::unix::fs::PermissionsExt;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let root = temp_dir.path().join(ATTACHMENT_VIEW_ROOT_NAME);
        fs::create_dir(&root).expect("create view root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .expect("make view root private");
        let foreign_uid = rustix::process::geteuid().as_raw().wrapping_add(1);

        let error = open_existing_attachment_view_root_for_uid(&root, foreign_uid)
            .expect_err("view root owned by another user");

        assert!(error.to_lowercase().contains("owner"), "{error}");
    }

    #[test]
    fn attachment_open_download_long_cjk_name_fits_one_file_component() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, bytes) = seed_open_download_attachment(&temp_dir);
        let connection = connect_notes_db(&vault_path).expect("open attachment database");
        let original_name = format!("{}.png", "사진자료".repeat(200));
        connection
            .execute(
                "UPDATE notes_attachments SET original_name = ?1 WHERE id = ?2",
                params![original_name, SPLIT_ID],
            )
            .expect("seed long CJK original name");
        drop(connection);
        let temp_parent = temp_dir.path().join("system-temp");
        fs::create_dir(&temp_parent).expect("create system temp parent");
        let opened = std::cell::RefCell::new(None);

        notes_open_attachment_original_with_opener(
            vault_path,
            SPLIT_ID.to_string(),
            &temp_parent,
            |path| {
                let name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .expect("UTF-8 view-copy name");
                assert!(name.as_bytes().len() <= 255, "{} bytes", name.len());
                assert!(name.starts_with(ATTACHMENT_VIEW_COPY_PREFIX), "{name}");
                assert!(name.contains("사진자료"), "{name}");
                assert!(name.ends_with(".png"), "{name}");
                assert_eq!(fs::read(path).expect("read CJK view copy"), bytes);
                opened.replace(Some(path.to_path_buf()));
                Ok(())
            },
        )
        .expect("open long CJK original name");

        assert!(opened.into_inner().expect("opened CJK copy").exists());
    }

    #[test]
    fn attachment_open_download_opener_failure_removes_just_created_copy() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let temp_parent = temp_dir.path().join("system-temp");
        fs::create_dir(&temp_parent).expect("create system temp parent");
        let attempted_path = std::cell::RefCell::new(None);

        let error = notes_open_attachment_original_with_opener(
            vault_path,
            SPLIT_ID.to_string(),
            &temp_parent,
            |path| {
                attempted_path.replace(Some(path.to_path_buf()));
                Err("injected opener failure".to_string())
            },
        )
        .expect_err("opener failure");

        assert_eq!(error, "injected opener failure");
        assert!(!attempted_path
            .into_inner()
            .expect("attempted copy path")
            .exists());
        assert!(fs::read_dir(temp_parent.join(ATTACHMENT_VIEW_ROOT_NAME))
            .expect("inspect view root after opener failure")
            .next()
            .is_none());
    }

    #[test]
    fn attachment_open_download_opener_failure_removes_readonly_copy_when_delete_requires_writable()
    {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let temp_parent = temp_dir.path().join("system-temp");
        fs::create_dir(&temp_parent).expect("create system temp parent");
        let attempted_path = std::cell::RefCell::new(None);
        let _fault = AttachmentViewCopyRemoveFaultGuard::enable(
            AttachmentViewCopyRemoveFault::PermissionDeniedIfReadonly,
        );

        let error = notes_open_attachment_original_with_opener(
            vault_path,
            SPLIT_ID.to_string(),
            &temp_parent,
            |path| {
                attempted_path.replace(Some(path.to_path_buf()));
                assert!(
                    fs::metadata(path)
                        .expect("readonly view copy metadata")
                        .permissions()
                        .readonly(),
                    "regression test needs a readonly view copy"
                );
                Err("injected opener failure".to_string())
            },
        )
        .expect_err("opener failure");

        assert_eq!(error, "injected opener failure");
        assert!(!attempted_path
            .into_inner()
            .expect("attempted copy path")
            .exists());
        assert!(fs::read_dir(temp_parent.join(ATTACHMENT_VIEW_ROOT_NAME))
            .expect("inspect view root after opener failure")
            .next()
            .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn attachment_open_original_revalidates_root_identity_before_opener() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let temp_parent = temp_dir.path().join("system-temp");
        fs::create_dir(&temp_parent).expect("create system temp parent");
        let moved_root = temp_dir.path().join("moved-view-root");
        let _fault = AttachmentViewCopyOpenValidationFaultGuard::enable(
            AttachmentViewCopyOpenValidationFault::ReplaceRoot {
                moved_root: moved_root.clone(),
            },
        );
        let opener_called = std::cell::Cell::new(false);

        let error = notes_open_attachment_original_with_opener(
            vault_path,
            SPLIT_ID.to_string(),
            &temp_parent,
            |_| {
                opener_called.set(true);
                Ok(())
            },
        )
        .expect_err("replaced view root");

        assert!(error.contains("view root changed"), "{error}");
        assert!(!opener_called.get());
        assert!(fs::read_dir(&moved_root)
            .expect("inspect moved held view root")
            .next()
            .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn attachment_open_original_revalidates_copy_identity_before_opener() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let temp_parent = temp_dir.path().join("system-temp");
        fs::create_dir(&temp_parent).expect("create system temp parent");
        let _fault = AttachmentViewCopyOpenValidationFaultGuard::enable(
            AttachmentViewCopyOpenValidationFault::ReplaceCopyWithFile,
        );
        let opener_called = std::cell::Cell::new(false);

        let error = notes_open_attachment_original_with_opener(
            vault_path,
            SPLIT_ID.to_string(),
            &temp_parent,
            |_| {
                opener_called.set(true);
                Ok(())
            },
        )
        .expect_err("replaced view copy");

        assert!(error.contains("copy changed"), "{error}");
        assert!(!opener_called.get());
        assert!(fs::read_dir(temp_parent.join(ATTACHMENT_VIEW_ROOT_NAME))
            .expect("inspect view root after copy replacement")
            .next()
            .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn attachment_open_original_rejects_hardlinked_copy_before_opener() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let temp_parent = temp_dir.path().join("system-temp");
        fs::create_dir(&temp_parent).expect("create system temp parent");
        let hardlink = temp_dir.path().join("copy-hardlink.png");
        let _fault = AttachmentViewCopyOpenValidationFaultGuard::enable(
            AttachmentViewCopyOpenValidationFault::HardlinkCopy {
                link_path: hardlink.clone(),
            },
        );
        let opener_called = std::cell::Cell::new(false);

        let error = notes_open_attachment_original_with_opener(
            vault_path,
            SPLIT_ID.to_string(),
            &temp_parent,
            |_| {
                opener_called.set(true);
                Ok(())
            },
        )
        .expect_err("hard-linked view copy");

        assert!(error.contains("hard-linked"), "{error}");
        assert!(!opener_called.get());
        assert!(
            hardlink.exists(),
            "same-user hardlink already created before validation remains outside the root"
        );
        fs::remove_file(&hardlink).expect("remove injected hardlink");
        assert!(fs::read_dir(temp_parent.join(ATTACHMENT_VIEW_ROOT_NAME))
            .expect("inspect view root after hardlink rejection")
            .next()
            .is_none());
    }

    #[test]
    fn attachment_open_download_rejects_vault_metadata_destinations() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let metadata = crate::metadata_dir(&vault_path);
        let database = metadata.join("notes.sqlite");
        let database_before = fs::read(&database).expect("read Notes database before rejection");
        let asset_before = fs::read(&asset_path).expect("read asset before rejection");

        for destination in [
            metadata.join("new-owned-file.png"),
            database.clone(),
            asset_path.clone(),
        ] {
            let error = notes_download_attachment(
                vault_path.clone(),
                SPLIT_ID.to_string(),
                destination.to_string_lossy().into_owned(),
            )
            .expect_err("Vault metadata destination");
            assert!(error.to_lowercase().contains("vault"), "{error}");
        }

        assert!(!metadata.join("new-owned-file.png").exists());
        assert_eq!(
            fs::read(&database).expect("read Notes database after rejection"),
            database_before
        );
        assert_eq!(
            fs::read(&asset_path).expect("read asset after rejection"),
            asset_before
        );
    }

    #[test]
    fn attachment_download_rejects_vault_content_destinations() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let vault_root = PathBuf::from(&vault_path);

        for destination in [
            vault_root.join("new-content.png"),
            vault_root.join("notes.md"),
        ] {
            let error = notes_download_attachment(
                vault_path.clone(),
                SPLIT_ID.to_string(),
                destination.to_string_lossy().into_owned(),
            )
            .expect_err("Vault content destination");

            assert!(error.to_lowercase().contains("vault"), "{error}");
            assert!(!destination.exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn attachment_open_download_rejects_symlink_alias_to_vault_metadata_parent() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let metadata = crate::metadata_dir(&vault_path);
        let alias = temp_dir.path().join("metadata-alias");
        symlink(&metadata, &alias).expect("create metadata parent alias");
        let destination = alias.join("new-via-alias.png");

        let error = notes_download_attachment(
            vault_path,
            SPLIT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
        )
        .expect_err("symlink alias to Vault metadata");

        assert!(error.to_lowercase().contains("vault"), "{error}");
        assert!(!metadata.join("new-via-alias.png").exists());
    }

    #[cfg(unix)]
    #[test]
    fn attachment_download_rejects_symlink_alias_to_vault_content_parent() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let alias = temp_dir.path().join("vault-alias");
        symlink(Path::new(&vault_path), &alias).expect("create Vault parent alias");
        let destination = alias.join("new-via-alias.png");

        let error = notes_download_attachment(
            vault_path.clone(),
            SPLIT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
        )
        .expect_err("symlink alias to Vault content");

        assert!(error.to_lowercase().contains("vault"), "{error}");
        assert!(!Path::new(&vault_path).join("new-via-alias.png").exists());
    }

    #[test]
    fn attachment_open_download_identity_comparison_uses_capability_metadata_only() {
        let comparison: fn(&cap_std::fs::Metadata, &cap_std::fs::Metadata) -> bool =
            attachment_capability_metadata_matches;

        let _ = comparison;
    }

    #[test]
    fn commands_source_stays_within_rust_1_77_option_apis() {
        let source = include_str!("commands.rs");
        let post_msrv_api = [".is_none", "_or("].concat();

        assert!(
            !source.contains(&post_msrv_api),
            "commands.rs must not use Option::is_none_or, which is newer than Rust 1.77"
        );
    }

    #[test]
    fn notes_history_user_mutation_inner_signatures_require_context() {
        let source = include_str!("commands.rs");
        for name in [
            "notes_create_node_inner",
            "notes_update_node_inner",
            "notes_split_node_inner",
            "notes_move_node_inner",
            "notes_apply_batch_inner",
            "notes_import_subtree_inner",
            "notes_toggle_complete_inner",
            "notes_toggle_collapsed_inner",
            "notes_collapse_all_inner",
            "notes_expand_all_inner",
            "notes_sort_subtree_ascending_inner",
            "notes_sort_subtree_descending_inner",
            "notes_toggle_star_inner",
            "notes_duplicate_node_inner",
            "notes_remove_empty_node_inner",
            "notes_soft_delete_node_inner",
            "notes_restore_node_inner",
            "notes_archive_node_inner",
            "notes_unarchive_node_inner",
            "notes_import_attachment_paths_batch_inner",
            "notes_import_image_node_paths_batch_inner",
            "notes_import_attachment_inner",
            "notes_resize_attachment_inner",
            "notes_remove_attachment_inner",
            "notes_restore_attachment_inner",
        ] {
            let start = source
                .find(&format!("fn {name}("))
                .unwrap_or_else(|| panic!("missing {name}"));
            let tail = &source[start..];
            let end = tail
                .find(") -> Result")
                .unwrap_or_else(|| panic!("missing end of {name} signature"));
            let signature = &tail[..end];
            assert!(
                !signature.contains("Option<NotesHistoryContext>"),
                "{name} accepts a missing history context"
            );
        }
    }

    #[test]
    fn windows_open_original_has_a_private_pinned_cache_contract() {
        let source = include_str!("commands.rs");
        let unconditional_rejection = ["privacy cannot be verified", " on Windows"].concat();
        let security_query = ["GetKernel", "ObjectSecurity"].concat();
        let protected_dacl = ["SE_DACL", "_PROTECTED"].concat();
        let direct_opener = ["open_attachment_original", "_windows"].concat();
        let direct_dispatch = ["ShellExecute", "ExW"].concat();
        let private_create = ["create_private_attachment_view_copy", "_windows"].concat();
        let pinned_ancestors = ["hold_attachment_view_windows", "_ancestors"].concat();
        let deny_delete_share = ["FILE_SHARE", "_READ"].concat();
        let reject_reparse = ["FILE_FLAG_OPEN", "_REPARSE_POINT"].concat();

        assert!(!source.contains(&unconditional_rejection));
        assert!(source.contains(&security_query));
        assert!(source.contains(&protected_dacl));
        assert!(source.contains(&direct_opener));
        assert!(source.contains(&direct_dispatch));
        assert!(source.contains(&private_create));
        assert!(source.contains(&pinned_ancestors));
        assert!(source.contains(&deny_delete_share));
        assert!(source.contains(&reject_reparse));
    }

    #[test]
    fn windows_download_overwrite_has_an_atomic_replace_contract() {
        let source = include_str!("commands.rs");
        let replace_api = ["Replace", "FileW"].concat();
        let windows_publish = ["publish_attachment_download", "_windows"].concat();
        let partial_recovery = ["recover_attachment_download_windows", "_replace_failure"].concat();

        assert!(source.contains(&replace_api));
        assert!(source.contains(&windows_publish));
        assert!(source.contains(&partial_recovery));
    }

    #[cfg(windows)]
    #[test]
    fn windows_download_guards_block_ancestor_relocation_during_replace_and_rollback() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault = temp_dir.path().join("vault");
        let outside = temp_dir.path().join("outside");
        let parent = outside.join("downloads");
        let moved = temp_dir.path().join("moved-outside");
        fs::create_dir(&vault).expect("create vault");
        fs::create_dir_all(&parent).expect("create destination parent");
        let destination_path = parent.join("download.png");
        fs::write(&destination_path, b"old destination").expect("seed destination");
        let vault_path = vault.to_string_lossy().into_owned();
        let destination = prepare_attachment_download_destination(&vault_path, &destination_path)
            .expect("prepare destination");

        assert!(
            fs::rename(&outside, &moved).is_err(),
            "a live destination guard must block ancestor relocation"
        );

        let mut staging =
            create_attachment_download_staging(&destination).expect("create staged download");
        staging
            .file
            .write_all(b"new destination")
            .expect("write staged download");
        staging.file.sync_all().expect("sync staged download");
        replace_attachment_download_windows(
            &destination.parent_path.join(&destination.file_name),
            &staging
                .directory_path
                .join(ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME),
            &staging
                .directory_path
                .join(ATTACHMENT_DOWNLOAD_BACKUP_FILE_NAME),
        )
        .expect("replace destination");
        assert_eq!(fs::read(&destination_path).unwrap(), b"new destination");
        assert!(fs::rename(&outside, &moved).is_err());

        rollback_attachment_download_windows(&destination, &staging)
            .expect("roll back replacement");
        assert_eq!(fs::read(&destination_path).unwrap(), b"old destination");
        assert_eq!(
            staging
                .directory
                .read(ATTACHMENT_DOWNLOAD_STAGED_FILE_NAME)
                .unwrap(),
            b"new destination"
        );
        cleanup_attachment_download_staging(staging).expect("clean staging directory");

        drop(destination);
        fs::rename(&outside, &moved).expect("ancestor relocates after guards close");
    }

    #[cfg(windows)]
    #[test]
    fn windows_download_parent_revalidation_fails_closed_on_path_identity_mismatch() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault = temp_dir.path().join("vault");
        let parent = temp_dir.path().join("downloads");
        let other = temp_dir.path().join("other");
        fs::create_dir(&vault).expect("create vault");
        fs::create_dir(&parent).expect("create destination parent");
        fs::create_dir(&other).expect("create different parent");
        let vault_path = vault.to_string_lossy().into_owned();
        let mut destination =
            prepare_attachment_download_destination(&vault_path, &parent.join("download.png"))
                .expect("prepare destination");
        destination.parent_path = other;

        let error = revalidate_attachment_download_destination_parent(&destination)
            .expect_err("Windows path identity mismatch must fail closed");

        assert!(error.to_lowercase().contains("changed"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn attachment_open_download_holds_destination_parent_across_replacement_race() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, bytes) = seed_open_download_attachment(&temp_dir);
        let parent = temp_dir.path().join("download-parent");
        let held_parent = temp_dir.path().join("held-parent");
        let attacker_parent = temp_dir.path().join("attacker-parent");
        fs::create_dir(&parent).expect("create destination parent");
        fs::create_dir(&attacker_parent).expect("create attacker parent");
        let destination = parent.join("download.png");
        fs::write(&destination, b"old destination").expect("seed destination");
        let attacker_sentinel = attacker_parent.join("keep.txt");
        fs::write(&attacker_sentinel, b"keep").expect("seed attacker sentinel");

        notes_download_attachment_with_hooks(
            vault_path,
            SPLIT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            || {
                fs::rename(&parent, &held_parent)
                    .map_err(|error| format!("replace destination parent: {error}"))?;
                symlink(&attacker_parent, &parent)
                    .map_err(|error| format!("install destination-parent symlink: {error}"))?;
                Ok(())
            },
            || Ok(()),
            || Ok(()),
        )
        .expect("download through held destination parent");

        assert_eq!(
            fs::read(held_parent.join("download.png")).expect("read held-parent destination"),
            bytes
        );
        assert!(!attacker_parent.join("download.png").exists());
        assert_eq!(
            fs::read(&attacker_sentinel).expect("read attacker sentinel"),
            b"keep"
        );
        assert!(fs::read_dir(&held_parent)
            .expect("inspect held parent")
            .all(|entry| {
                !entry
                    .expect("held-parent entry")
                    .file_name()
                    .to_string_lossy()
                    .starts_with(ATTACHMENT_DOWNLOAD_TEMP_PREFIX)
            }));
    }

    #[cfg(unix)]
    #[test]
    fn attachment_download_rejects_held_parent_relocated_into_vault() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let parent = temp_dir.path().join("download-parent");
        fs::create_dir(&parent).expect("create destination parent");
        let destination = parent.join("download.png");
        let relocated_parent = Path::new(&vault_path).join("relocated-download-parent");

        let error = notes_download_attachment_with_hooks(
            vault_path,
            SPLIT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            || {
                fs::rename(&parent, &relocated_parent)
                    .map_err(|error| format!("relocate destination parent: {error}"))?;
                fs::create_dir(&parent)
                    .map_err(|error| format!("replace destination parent: {error}"))?;
                Ok(())
            },
            || Ok(()),
            || Ok(()),
        )
        .expect_err("held parent relocated into Vault");

        assert!(error.to_lowercase().contains("vault"), "{error}");
        assert!(!relocated_parent.join("download.png").exists());
        assert!(!destination.exists());
    }

    #[cfg(unix)]
    #[test]
    fn attachment_download_rejects_parent_relocated_after_final_validation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let parent = temp_dir.path().join("download-parent");
        fs::create_dir(&parent).expect("create destination parent");
        let destination = parent.join("download.png");
        fs::write(&destination, b"expected old destination").expect("seed destination");
        let relocated_parent = Path::new(&vault_path).join("post-validation-parent");

        let error = notes_download_attachment_with_hooks(
            vault_path,
            SPLIT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            || Ok(()),
            || Ok(()),
            || {
                fs::rename(&parent, &relocated_parent)
                    .map_err(|error| format!("relocate validated destination parent: {error}"))?;
                fs::create_dir(&parent)
                    .map_err(|error| format!("replace validated destination parent: {error}"))?;
                fs::write(&destination, b"unexpected replacement target")
                    .map_err(|error| format!("seed unexpected replacement target: {error}"))?;
                Ok(())
            },
        )
        .expect_err("post-validation relocation into Vault");

        assert!(error.to_lowercase().contains("changed"), "{error}");
        assert_eq!(
            fs::read(relocated_parent.join("download.png"))
                .expect("read original target after rejected publication"),
            b"expected old destination"
        );
        assert_eq!(
            fs::read(&destination).expect("read unexpected replacement target"),
            b"unexpected replacement target"
        );
        for directory in [&relocated_parent, &parent] {
            assert!(fs::read_dir(directory)
                .expect("inspect publication directory")
                .all(|entry| {
                    !entry
                        .expect("publication directory entry")
                        .file_name()
                        .to_string_lossy()
                        .starts_with(ATTACHMENT_DOWNLOAD_TEMP_PREFIX)
                }));
        }
    }

    #[cfg(unix)]
    #[test]
    fn attachment_download_does_not_overwrite_target_created_after_final_validation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let parent = temp_dir.path().join("download-parent");
        fs::create_dir(&parent).expect("create destination parent");
        let destination = parent.join("download.png");

        let error = notes_download_attachment_with_hooks(
            vault_path,
            SPLIT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            || Ok(()),
            || Ok(()),
            || {
                fs::write(&destination, b"unexpected late target")
                    .map_err(|error| format!("seed late destination target: {error}"))
            },
        )
        .expect_err("late destination target");

        assert!(error.to_lowercase().contains("changed"), "{error}");
        assert_eq!(
            fs::read(&destination).expect("read late destination target"),
            b"unexpected late target"
        );
        assert!(fs::read_dir(&parent)
            .expect("inspect destination parent")
            .all(|entry| {
                !entry
                    .expect("destination entry")
                    .file_name()
                    .to_string_lossy()
                    .starts_with(ATTACHMENT_DOWNLOAD_TEMP_PREFIX)
            }));
    }

    #[cfg(unix)]
    #[test]
    fn attachment_download_does_not_overwrite_target_created_after_dialog_selection() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let parent = temp_dir.path().join("download-parent");
        fs::create_dir(&parent).expect("create destination parent");
        let destination = parent.join("download.png");

        let error = notes_download_attachment_with_hooks(
            vault_path,
            SPLIT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            || Ok(()),
            || {
                fs::write(&destination, b"target created after dialog")
                    .map_err(|error| format!("seed post-dialog destination: {error}"))
            },
            || Ok(()),
        )
        .expect_err("post-dialog destination target");

        assert!(error.to_lowercase().contains("changed"), "{error}");
        assert_eq!(
            fs::read(&destination).expect("read post-dialog destination"),
            b"target created after dialog"
        );
        assert!(fs::read_dir(&parent)
            .expect("inspect destination parent")
            .all(|entry| {
                !entry
                    .expect("destination entry")
                    .file_name()
                    .to_string_lossy()
                    .starts_with(ATTACHMENT_DOWNLOAD_TEMP_PREFIX)
            }));
    }

    #[cfg(unix)]
    #[test]
    fn attachment_download_does_not_overwrite_target_swapped_after_final_validation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let parent = temp_dir.path().join("download-parent");
        fs::create_dir(&parent).expect("create destination parent");
        let destination = parent.join("download.png");
        let displaced = parent.join("displaced-original.png");
        fs::write(&destination, b"expected original target").expect("seed original target");

        let error = notes_download_attachment_with_hooks(
            vault_path,
            SPLIT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            || Ok(()),
            || Ok(()),
            || {
                fs::rename(&destination, &displaced)
                    .map_err(|error| format!("displace original destination target: {error}"))?;
                fs::write(&destination, b"unexpected replacement target")
                    .map_err(|error| format!("seed replacement destination target: {error}"))
            },
        )
        .expect_err("swapped destination target");

        assert!(error.to_lowercase().contains("changed"), "{error}");
        assert_eq!(
            fs::read(&destination).expect("read replacement target"),
            b"unexpected replacement target"
        );
        assert_eq!(
            fs::read(&displaced).expect("read displaced original target"),
            b"expected original target"
        );
        assert!(fs::read_dir(&parent)
            .expect("inspect destination parent")
            .all(|entry| {
                !entry
                    .expect("destination entry")
                    .file_name()
                    .to_string_lossy()
                    .starts_with(ATTACHMENT_DOWNLOAD_TEMP_PREFIX)
            }));
    }

    #[cfg(unix)]
    #[test]
    fn attachment_download_rolls_back_staged_bytes_after_final_check_destination_substitution() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, staged_bytes) = seed_open_download_attachment(&temp_dir);
        let parent = temp_dir.path().join("download-parent");
        fs::create_dir(&parent).expect("create destination parent");
        let destination = parent.join("download.png");
        let displaced_original = parent.join("displaced-original.png");
        let original = b"expected original destination";
        let substitute = b"post-check destination substitute";
        fs::write(&destination, original).expect("seed original destination");
        let hook_destination = destination.clone();
        let hook_displaced = displaced_original.clone();
        let _hook = AttachmentDownloadBeforeExistingPublicationHookGuard::enable(move || {
            fs::rename(&hook_destination, &hook_displaced)
                .map_err(|error| format!("displace final-checked destination: {error}"))?;
            fs::write(&hook_destination, substitute)
                .map_err(|error| format!("substitute final-checked destination: {error}"))
        });

        let error = notes_download_attachment_with_hooks(
            vault_path,
            SPLIT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            || Ok(()),
            || Ok(()),
            || Ok(()),
        )
        .expect_err("destination substituted after final publication check");

        assert!(error.to_lowercase().contains("changed"), "{error}");
        let destination_bytes = fs::read(&destination).expect("read substituted destination");
        assert_eq!(destination_bytes, substitute);
        assert_ne!(destination_bytes, staged_bytes);
        assert_eq!(
            fs::read(&displaced_original).expect("read displaced original destination"),
            original
        );
        assert!(fs::read_dir(&parent)
            .expect("inspect destination parent")
            .all(|entry| {
                !entry
                    .expect("destination entry")
                    .file_name()
                    .to_string_lossy()
                    .starts_with(ATTACHMENT_DOWNLOAD_TEMP_PREFIX)
            }));
    }

    fn attachment_download_staged_source(parent: &Path) -> PathBuf {
        let mut staging_entries = fs::read_dir(parent)
            .expect("inspect attachment download staging parent")
            .filter_map(|entry| {
                let entry = entry.expect("read attachment download staging entry");
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(ATTACHMENT_DOWNLOAD_TEMP_PREFIX)
                    .then(|| entry.path())
            })
            .collect::<Vec<_>>();
        assert_eq!(staging_entries.len(), 1, "one staged download path");
        let staging_entry = staging_entries.pop().unwrap();
        if staging_entry.is_dir() {
            let mut children = fs::read_dir(&staging_entry)
                .expect("inspect private attachment download staging directory")
                .map(|entry| entry.expect("read staged download child").path())
                .collect::<Vec<_>>();
            assert_eq!(children.len(), 1, "one staged download child");
            children.pop().unwrap()
        } else {
            staging_entry
        }
    }

    fn assert_attachment_download_has_no_displaced_original(
        parent: &Path,
        destination: &Path,
        original: &[u8],
    ) {
        let mut pending = vec![parent.to_path_buf()];
        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(directory).expect("scan attachment download publication") {
                let path = entry
                    .expect("read attachment download publication entry")
                    .path();
                if path.is_dir() {
                    pending.push(path);
                } else if path != destination {
                    assert_ne!(
                        fs::read(&path).expect("read attachment download publication file"),
                        original,
                        "original destination was displaced to {}",
                        path.display()
                    );
                }
            }
        }
    }

    fn assert_attachment_download_has_no_replacement_backup(parent: &Path) {
        let mut pending = vec![parent.to_path_buf()];
        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(directory).expect("scan attachment download backups") {
                let path = entry.expect("read attachment download backup entry").path();
                if path.is_dir() {
                    pending.push(path);
                } else {
                    let name = path.file_name().unwrap().to_string_lossy();
                    assert!(
                        name != "replaced" && !name.ends_with(".replaced"),
                        "attachment download left a displaced backup at {}",
                        path.display()
                    );
                }
            }
        }
    }

    #[test]
    fn attachment_download_rejects_substituted_staged_source_before_creating_destination() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let parent = temp_dir.path().join("download-parent");
        fs::create_dir(&parent).expect("create destination parent");
        let destination = parent.join("download.png");
        let moved_staged_source = parent.join("moved-staged-source.png");

        let error = notes_download_attachment_with_hooks(
            vault_path,
            SPLIT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            || Ok(()),
            || Ok(()),
            || {
                let staged_source = attachment_download_staged_source(&parent);
                fs::rename(&staged_source, &moved_staged_source)
                    .map_err(|error| format!("move staged download source: {error}"))?;
                fs::write(&staged_source, b"substituted staged source")
                    .map_err(|error| format!("substitute staged download source: {error}"))
            },
        )
        .expect_err("substituted staged source");

        assert!(error.to_lowercase().contains("changed"), "{error}");
        assert!(!destination.exists(), "destination must remain missing");
        assert!(
            moved_staged_source.exists(),
            "owned staged source was moved"
        );
        assert_attachment_download_has_no_replacement_backup(&parent);
    }

    #[test]
    fn attachment_download_rejects_substituted_staged_source_before_displacing_destination() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let parent = temp_dir.path().join("download-parent");
        fs::create_dir(&parent).expect("create destination parent");
        let destination = parent.join("download.png");
        let original = b"expected original destination";
        fs::write(&destination, original).expect("seed original destination");
        let moved_staged_source = parent.join("moved-staged-source.png");

        let error = notes_download_attachment_with_hooks(
            vault_path,
            SPLIT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            || Ok(()),
            || Ok(()),
            || {
                let staged_source = attachment_download_staged_source(&parent);
                fs::rename(&staged_source, &moved_staged_source)
                    .map_err(|error| format!("move staged download source: {error}"))?;
                fs::write(&staged_source, b"substituted staged source")
                    .map_err(|error| format!("substitute staged download source: {error}"))
            },
        )
        .expect_err("substituted staged source");

        assert!(error.to_lowercase().contains("changed"), "{error}");
        assert_eq!(
            fs::read(&destination).expect("read original destination"),
            original
        );
        assert!(
            moved_staged_source.exists(),
            "owned staged source was moved"
        );
        assert_attachment_download_has_no_displaced_original(&parent, &destination, original);
        assert_attachment_download_has_no_replacement_backup(&parent);
    }

    #[test]
    fn attachment_open_download_removes_destination_temp_after_publication_failure() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let parent = temp_dir.path().join("download-parent");
        fs::create_dir(&parent).expect("create destination parent");
        let destination = parent.join("download.png");
        fs::write(&destination, b"old destination").expect("seed destination");
        let entries_before = fs::read_dir(&parent)
            .expect("inspect destination parent before failure")
            .map(|entry| entry.expect("destination entry").file_name())
            .collect::<HashSet<_>>();

        let error = notes_download_attachment_with_hooks(
            vault_path,
            SPLIT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            || Ok(()),
            || Err("injected download publication failure".to_string()),
            || Ok(()),
        )
        .expect_err("injected publication failure");

        assert_eq!(error, "injected download publication failure");
        assert_eq!(
            fs::read(&destination).expect("read unchanged destination"),
            b"old destination"
        );
        let entries_after = fs::read_dir(&parent)
            .expect("inspect destination parent after failure")
            .map(|entry| entry.expect("destination entry").file_name())
            .collect::<HashSet<_>>();
        assert_eq!(entries_after, entries_before);
    }

    #[test]
    fn attachment_open_download_rejects_unknown_removed_and_cross_vault_ids() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let temp_parent = temp_dir.path().join("system-temp");
        fs::create_dir(&temp_parent).expect("create system temp parent");
        let destination = temp_dir.path().join("rejected.png");

        assert_open_and_download_rejected(
            &vault_path,
            BATCH_MISSING_ID,
            &temp_parent,
            &destination,
        );

        let other_vault = temp_dir.path().join("other-vault");
        let other_vault_path = other_vault.to_string_lossy().into_owned();
        notes_initialize(other_vault_path.clone()).expect("initialize other vault");
        assert_open_and_download_rejected(&other_vault_path, SPLIT_ID, &temp_parent, &destination);

        notes_remove_attachment(vault_path.clone(), SPLIT_ID.to_string(), None)
            .expect("remove attachment");
        assert_open_and_download_rejected(&vault_path, SPLIT_ID, &temp_parent, &destination);
        assert!(!destination.exists());
    }

    #[test]
    fn attachment_download_rejects_same_id_replacement_after_source_capture() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let destination = temp_dir.path().join("replacement-rejected.png");
        let replacement_vault_path = vault_path.clone();

        let error = notes_download_attachment_with_hooks(
            vault_path,
            SPLIT_ID.to_string(),
            destination.clone(),
            move || {
                let connection = connect_notes_db(&replacement_vault_path)
                    .map_err(|error| format!("open replacement database: {error}"))?;
                connection
                    .execute(
                        "UPDATE notes_attachments SET original_name = 'replacement.png' WHERE id = ?1",
                        [SPLIT_ID],
                    )
                    .map_err(|error| format!("replace attachment identity: {error}"))?;
                Ok(())
            },
            || Ok(()),
            || Ok(()),
        )
        .expect_err("same attachment ID with different metadata must be rejected");

        assert!(error.to_lowercase().contains("changed"), "{error}");
        assert!(!destination.exists());
    }

    #[test]
    fn attachment_open_download_rejects_tampered_relative_path() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let temp_parent = temp_dir.path().join("system-temp");
        fs::create_dir(&temp_parent).expect("create system temp parent");
        let connection = connect_notes_db(&vault_path).expect("tamper attachment metadata");
        connection
            .execute(
                "UPDATE notes_attachments SET relative_path = '../outside.png' WHERE id = ?1",
                [SPLIT_ID],
            )
            .expect("tamper relative path");
        drop(connection);

        assert_open_and_download_rejected(
            &vault_path,
            SPLIT_ID,
            &temp_parent,
            &temp_dir.path().join("rejected.png"),
        );
        assert!(!temp_parent.join(ATTACHMENT_VIEW_ROOT_NAME).exists());
    }

    #[test]
    fn attachment_open_download_rejects_owned_hash_mismatch_without_touching_destination() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let temp_parent = temp_dir.path().join("system-temp");
        fs::create_dir(&temp_parent).expect("create system temp parent");
        fs::write(&asset_path, encoded_png(9, 7)).expect("tamper owned attachment bytes");
        let destination = temp_dir.path().join("existing.png");
        fs::write(&destination, b"existing destination").expect("seed destination");
        let entries_before = fs::read_dir(temp_dir.path())
            .expect("read parent before rejection")
            .map(|entry| entry.expect("parent entry").file_name())
            .collect::<HashSet<_>>();

        assert_open_and_download_rejected(&vault_path, SPLIT_ID, &temp_parent, &destination);

        assert_eq!(
            fs::read(&destination).expect("read unchanged destination"),
            b"existing destination"
        );
        let entries_after = fs::read_dir(temp_dir.path())
            .expect("read parent after rejection")
            .map(|entry| entry.expect("parent entry").file_name())
            .collect::<HashSet<_>>();
        assert_eq!(entries_after, entries_before);
        assert!(!temp_parent.join(ATTACHMENT_VIEW_ROOT_NAME).exists());
    }

    #[cfg(unix)]
    #[test]
    fn attachment_open_download_rejects_symlinked_owned_asset() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, asset_path, bytes) = seed_open_download_attachment(&temp_dir);
        let temp_parent = temp_dir.path().join("system-temp");
        fs::create_dir(&temp_parent).expect("create system temp parent");
        let outside = temp_dir.path().join("outside.png");
        fs::write(&outside, bytes).expect("write outside image");
        fs::remove_file(&asset_path).expect("remove owned image");
        symlink(&outside, &asset_path).expect("replace owned image with symlink");

        assert_open_and_download_rejected(
            &vault_path,
            SPLIT_ID,
            &temp_parent,
            &temp_dir.path().join("rejected.png"),
        );
        assert!(asset_path
            .symlink_metadata()
            .expect("asset symlink")
            .is_symlink());
        assert!(outside.exists());
    }

    #[test]
    fn attachment_open_download_rejects_directory_destination() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let destination = temp_dir.path().join("destination");
        fs::create_dir(&destination).expect("create destination directory");

        let error = notes_download_attachment(
            vault_path,
            SPLIT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
        )
        .expect_err("directory destination");

        assert!(error.contains("regular file"), "{error}");
        assert!(destination.is_dir());
        assert_eq!(
            fs::read_dir(temp_dir.path())
                .expect("read destination parent")
                .count(),
            3
        );
    }

    #[cfg(unix)]
    #[test]
    fn attachment_open_download_rejects_links_fifo_socket_and_device_destinations() {
        use std::os::unix::fs::symlink;
        use std::os::unix::net::UnixListener;
        use std::process::Command;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let outside = temp_dir.path().join("outside.png");
        fs::write(&outside, b"outside").expect("seed symlink target");
        let symlink_destination = temp_dir.path().join("symlink.png");
        symlink(&outside, &symlink_destination).expect("seed destination symlink");
        let dangling_destination = temp_dir.path().join("dangling.png");
        symlink("missing.png", &dangling_destination).expect("seed dangling destination");
        let fifo_destination = temp_dir.path().join("destination.fifo");
        let status = Command::new("mkfifo")
            .arg(&fifo_destination)
            .status()
            .expect("run mkfifo");
        assert!(status.success(), "mkfifo failed");
        let socket_destination = temp_dir.path().join("destination.sock");
        let _listener = UnixListener::bind(&socket_destination).expect("bind destination socket");
        let entries_before = fs::read_dir(temp_dir.path())
            .expect("read destination parent before rejection")
            .map(|entry| entry.expect("destination entry").file_name())
            .collect::<HashSet<_>>();

        for destination in [
            symlink_destination.as_path(),
            dangling_destination.as_path(),
            fifo_destination.as_path(),
            socket_destination.as_path(),
            Path::new("/dev/null"),
        ] {
            let error = notes_download_attachment(
                vault_path.clone(),
                SPLIT_ID.to_string(),
                destination.to_string_lossy().into_owned(),
            )
            .expect_err("non-regular destination");
            assert!(
                error.contains("regular file"),
                "{}: {error}",
                destination.display()
            );
        }

        assert_eq!(fs::read(&outside).expect("outside target"), b"outside");
        assert_eq!(
            fs::read_link(&dangling_destination).expect("dangling link"),
            PathBuf::from("missing.png")
        );
        let entries_after = fs::read_dir(temp_dir.path())
            .expect("read destination parent after rejection")
            .map(|entry| entry.expect("destination entry").file_name())
            .collect::<HashSet<_>>();
        assert_eq!(entries_after, entries_before);
    }

    #[cfg(unix)]
    #[test]
    fn attachment_open_download_rejects_symlinked_temp_root() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let temp_parent = temp_dir.path().join("system-temp");
        let outside = temp_dir.path().join("outside-temp-root");
        fs::create_dir(&temp_parent).expect("create system temp parent");
        fs::create_dir(&outside).expect("create outside temp root");
        let sentinel = outside.join("keep.txt");
        fs::write(&sentinel, b"keep").expect("write outside sentinel");
        symlink(&outside, temp_parent.join(ATTACHMENT_VIEW_ROOT_NAME))
            .expect("symlink app temp root");
        let opener_called = std::cell::Cell::new(false);

        let error = notes_open_attachment_original_with_opener(
            vault_path,
            SPLIT_ID.to_string(),
            &temp_parent,
            |_| {
                opener_called.set(true);
                Ok(())
            },
        )
        .expect_err("symlinked temp root");

        assert!(error.contains("symlink"), "{error}");
        assert!(!opener_called.get());
        assert_eq!(fs::read(&sentinel).expect("outside sentinel"), b"keep");
    }

    #[cfg(unix)]
    #[test]
    fn attachment_open_download_stale_cleanup_is_bounded_and_cannot_escape() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let root = temp_dir.path().join(ATTACHMENT_VIEW_ROOT_NAME);
        fs::create_dir(&root).expect("create owned temp root");
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .expect("make cleanup root private");
        let stale_count = MAX_STALE_ATTACHMENT_VIEW_COPY_REMOVALS + 3;
        for index in 0..stale_count {
            fs::write(
                root.join(format!("{ATTACHMENT_VIEW_COPY_PREFIX}{index}.png")),
                b"stale",
            )
            .expect("write stale copy");
        }
        let outside = temp_dir.path().join("outside.txt");
        fs::write(&outside, b"outside").expect("write outside target");
        let escape = root.join(format!("{ATTACHMENT_VIEW_COPY_PREFIX}escape.png"));
        symlink(&outside, &escape).expect("seed escape symlink");
        let nested = root.join(format!("{ATTACHMENT_VIEW_COPY_PREFIX}nested"));
        fs::create_dir(&nested).expect("seed nested directory");
        fs::write(nested.join("keep.txt"), b"nested").expect("seed nested file");

        let removed = cleanup_attachment_view_copies(
            &root,
            std::time::SystemTime::now() + ATTACHMENT_VIEW_COPY_MAX_AGE,
        )
        .expect("clean stale view copies");

        assert_eq!(removed, MAX_STALE_ATTACHMENT_VIEW_COPY_REMOVALS);
        assert_eq!(fs::read(&outside).expect("outside target"), b"outside");
        assert!(escape.symlink_metadata().expect("escape link").is_symlink());
        assert_eq!(
            fs::read(nested.join("keep.txt")).expect("nested file"),
            b"nested"
        );
    }

    #[test]
    fn attachment_open_download_cleanup_scan_ignores_noncopy_starvation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let root = temp_dir.path().join(ATTACHMENT_VIEW_ROOT_NAME);
        fs::create_dir(&root).expect("create owned temp root");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .expect("make cleanup root private");
        }
        for index in 0..(MAX_SCANNED_ATTACHMENT_VIEW_ENTRIES + 16) {
            fs::write(root.join(format!("noncopy-{index:03}.tmp")), b"ignore")
                .expect("write noncopy entry");
        }
        let stale_copy = root.join(format!("{ATTACHMENT_VIEW_COPY_PREFIX}stale.png"));
        fs::write(&stale_copy, b"stale").expect("write stale copy");

        let removed =
            cleanup_attachment_view_copies(&root, SystemTime::now() + ATTACHMENT_VIEW_COPY_MAX_AGE)
                .expect("cleanup should find stale copy after noncopy entries");

        assert_eq!(removed, 1);
        assert!(!stale_copy.exists());
    }

    #[test]
    fn attachment_open_download_stale_cleanup_continues_after_one_delete_failure() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let root = temp_dir.path().join(ATTACHMENT_VIEW_ROOT_NAME);
        fs::create_dir(&root).expect("create owned temp root");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .expect("make cleanup root private");
        }
        let denied_name = OsString::from(format!("{ATTACHMENT_VIEW_COPY_PREFIX}00.png"));
        fs::write(root.join(Path::new(&denied_name)), b"stuck")
            .expect("write undeletable stale copy");
        for index in 1..=MAX_STALE_ATTACHMENT_VIEW_COPY_REMOVALS {
            fs::write(
                root.join(format!("{ATTACHMENT_VIEW_COPY_PREFIX}{index:02}.png")),
                b"stale",
            )
            .expect("write removable stale copy");
        }
        let _fault = AttachmentViewCopyRemoveFaultGuard::enable(
            AttachmentViewCopyRemoveFault::PermissionDeniedForName(denied_name.clone()),
        );

        let removed = cleanup_attachment_view_copies(
            &root,
            std::time::SystemTime::now() + ATTACHMENT_VIEW_COPY_MAX_AGE,
        )
        .expect("cleanup should continue past one undeletable copy");

        assert_eq!(removed, MAX_STALE_ATTACHMENT_VIEW_COPY_REMOVALS);
        let remaining = fs::read_dir(&root)
            .expect("inspect cleanup root")
            .map(|entry| entry.expect("remaining entry").file_name())
            .collect::<HashSet<_>>();
        assert_eq!(remaining, HashSet::from([denied_name]));
    }

    #[test]
    fn attachment_open_download_fresh_overflow_continues_after_oldest_delete_failure() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let root = temp_dir.path().join(ATTACHMENT_VIEW_ROOT_NAME);
        fs::create_dir(&root).expect("create owned temp root");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .expect("make cleanup root private");
        }
        let denied_name = OsString::from(format!("{ATTACHMENT_VIEW_COPY_PREFIX}000.png"));
        let next_name = OsString::from(format!("{ATTACHMENT_VIEW_COPY_PREFIX}001.png"));
        for index in 0..=MAX_RETAINED_ATTACHMENT_VIEW_COPIES {
            fs::write(
                root.join(format!("{ATTACHMENT_VIEW_COPY_PREFIX}{index:03}.png")),
                b"fresh",
            )
            .expect("write fresh view copy");
        }
        let now = SystemTime::now();
        let denied_modified = fs::metadata(root.join(Path::new(&denied_name)))
            .and_then(|metadata| metadata.modified())
            .expect("inspect denied view-copy timestamp");
        for index in 0..=MAX_RETAINED_ATTACHMENT_VIEW_COPIES {
            let modified =
                fs::metadata(root.join(format!("{ATTACHMENT_VIEW_COPY_PREFIX}{index:03}.png")))
                    .and_then(|metadata| metadata.modified())
                    .expect("inspect fresh view-copy timestamp");
            assert!(
                denied_modified <= modified,
                "denied overflow fixture must be the oldest candidate"
            );
            assert!(
                !now.duration_since(modified)
                    .is_ok_and(|age| age >= ATTACHMENT_VIEW_COPY_MAX_AGE),
                "overflow fixture must not be stale"
            );
        }
        let _fault = AttachmentViewCopyRemoveFaultGuard::enable(
            AttachmentViewCopyRemoveFault::PermissionDeniedForName(denied_name.clone()),
        );

        let removed = cleanup_attachment_view_copies(&root, now)
            .expect("cleanup should continue overflow removal after one failure");

        assert_eq!(removed, 1);
        assert!(root.join(Path::new(&denied_name)).exists());
        assert!(!root.join(Path::new(&next_name)).exists());
        assert_eq!(
            fs::read_dir(&root)
                .expect("inspect retained fresh copies")
                .count(),
            MAX_RETAINED_ATTACHMENT_VIEW_COPIES
        );
    }

    #[test]
    fn attachment_open_original_keeps_post_creation_retention_within_capacity() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let temp_parent = temp_dir.path().join("system-temp");
        let root = temp_parent.join(ATTACHMENT_VIEW_ROOT_NAME);
        fs::create_dir(&temp_parent).expect("create system temp parent");
        fs::create_dir(&root).expect("create owned temp root");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .expect("make cleanup root private");
        }
        for index in 0..MAX_RETAINED_ATTACHMENT_VIEW_COPIES {
            fs::write(
                root.join(format!("{ATTACHMENT_VIEW_COPY_PREFIX}{index:03}.png")),
                b"fresh",
            )
            .expect("write retained view copy");
        }

        notes_open_attachment_original_with_opener(
            vault_path,
            SPLIT_ID.to_string(),
            &temp_parent,
            |_| Ok(()),
        )
        .expect("open with capacity cleanup");

        assert_eq!(
            fs::read_dir(&root)
                .expect("inspect retained view copies")
                .count(),
            MAX_RETAINED_ATTACHMENT_VIEW_COPIES
        );
    }

    #[test]
    fn attachment_open_original_refuses_new_copy_when_cleanup_cannot_make_capacity() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let (vault_path, _asset_path, _bytes) = seed_open_download_attachment(&temp_dir);
        let temp_parent = temp_dir.path().join("system-temp");
        let root = temp_parent.join(ATTACHMENT_VIEW_ROOT_NAME);
        fs::create_dir(&temp_parent).expect("create system temp parent");
        fs::create_dir(&root).expect("create owned temp root");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .expect("make cleanup root private");
        }
        for index in 0..MAX_RETAINED_ATTACHMENT_VIEW_COPIES {
            fs::write(
                root.join(format!("{ATTACHMENT_VIEW_COPY_PREFIX}{index:03}.png")),
                b"fresh",
            )
            .expect("write retained view copy");
        }
        let _fault = AttachmentViewCopyRemoveFaultGuard::enable(
            AttachmentViewCopyRemoveFault::PermissionDeniedForAll,
        );
        let opener_called = std::cell::Cell::new(false);

        let error = notes_open_attachment_original_with_opener(
            vault_path,
            SPLIT_ID.to_string(),
            &temp_parent,
            |_| {
                opener_called.set(true);
                Ok(())
            },
        )
        .expect_err("capacity cleanup failure");

        assert!(error.to_lowercase().contains("capacity"), "{error}");
        assert!(!opener_called.get());
        assert_eq!(
            fs::read_dir(&root)
                .expect("inspect retained view copies after failure")
                .count(),
            MAX_RETAINED_ATTACHMENT_VIEW_COPIES
        );
    }

    #[test]
    fn attachment_open_download_failed_delete_restores_readonly_copy() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let root = temp_dir.path().join(ATTACHMENT_VIEW_ROOT_NAME);
        fs::create_dir(&root).expect("create owned temp root");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .expect("make cleanup root private");
        }
        let file_name = OsString::from(format!("{ATTACHMENT_VIEW_COPY_PREFIX}readonly.png"));
        let path = root.join(Path::new(&file_name));
        fs::write(&path, b"readonly").expect("write readonly view copy");
        let mut permissions = fs::metadata(&path)
            .expect("inspect readonly view copy")
            .permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).expect("make view copy readonly");
        let root_dir = open_existing_attachment_view_root(&root).expect("open owned temp root");
        assert!(
            root_dir
                .symlink_metadata(&file_name)
                .expect("inspect readonly fixture through root")
                .permissions()
                .readonly(),
            "regression test needs a read-only view copy"
        );
        let _fault = AttachmentViewCopyRemoveFaultGuard::enable(
            AttachmentViewCopyRemoveFault::PermissionDeniedAfterReadonlyClearForName(
                file_name.clone(),
            ),
        );

        let error = remove_attachment_view_copy(&root_dir, &file_name)
            .expect_err("injected delete failure after clearing readonly");

        assert_eq!(error.kind(), ErrorKind::PermissionDenied);
        assert_eq!(
            error.to_string(),
            "injected view-copy delete denial after read-only clear"
        );
        assert!(path.exists());
        assert!(
            fs::metadata(&path)
                .expect("inspect surviving view copy")
                .permissions()
                .readonly(),
            "failed deletion must restore the copy's read-only attribute"
        );
        drop(_fault);
        remove_attachment_view_copy(&root_dir, &file_name).expect("remove restored test copy");
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
            history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
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
        let shared = acquire_notes_connection(&vault_path).expect("history database");
        let connection = lock_notes_connection(&shared).expect("lock history database");
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
            .map_or(true, Vec::is_empty));
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
    fn independent_image_node_soft_delete_retains_asset_until_empty_trash_reconciles() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        initialize_empty_test_vault(&vault_path);

        let (_imported, attachment) =
            import_single_independent_raw_image_node(&vault_path, "single.png");
        let asset_path = owned_asset_path(&vault_path, &attachment.relative_path);
        let asset_file_name = asset_file_name(&attachment.relative_path);
        assert!(asset_path.is_file());
        assert_eq!(
            asset_directory_entries(&vault_path),
            vec![asset_file_name.clone()]
        );
        assert_eq!(node_row_count(&vault_path, IMAGE_NODE_A_ID), 1);
        assert_eq!(attachment_row_count(&vault_path, IMAGE_ATTACHMENT_A_ID), 1);
        assert_eq!(attachment_count(&vault_path), 1);

        let deleted = notes_soft_delete_node(vault_path.clone(), IMAGE_NODE_A_ID.to_string(), None)
            .expect("soft delete image node");
        assert!(deleted.workspace.nodes.is_empty());
        assert!(asset_path.is_file());
        assert_eq!(attachment_row_count(&vault_path, IMAGE_ATTACHMENT_A_ID), 1);
        let trash = notes_load_workspace(vault_path.clone(), NotesWorkspaceScope::Trash)
            .expect("load trash workspace");
        assert_imported_image_node(
            &trash,
            IMAGE_NODE_A_ID,
            IMAGE_ATTACHMENT_A_ID,
            None,
            "single.png",
        );
        assert!(trash
            .nodes
            .iter()
            .find(|node| node.id == IMAGE_NODE_A_ID)
            .expect("trashed image node")
            .deleted_at
            .is_some());

        let restored = notes_restore_node(vault_path.clone(), IMAGE_NODE_A_ID.to_string(), None)
            .expect("restore image node");
        assert_imported_image_node(
            &restored.workspace,
            IMAGE_NODE_A_ID,
            IMAGE_ATTACHMENT_A_ID,
            None,
            "single.png",
        );
        assert!(asset_path.is_file());
        assert_eq!(attachment_row_count(&vault_path, IMAGE_ATTACHMENT_A_ID), 1);

        notes_soft_delete_node(vault_path.clone(), IMAGE_NODE_A_ID.to_string(), None)
            .expect("soft delete image node before empty trash");
        let emptied = notes_empty_trash(vault_path.clone()).expect("empty trash");
        assert!(emptied.nodes.is_empty());
        assert!(
            notes_load_workspace(vault_path.clone(), NotesWorkspaceScope::Trash)
                .expect("load emptied trash")
                .nodes
                .is_empty()
        );
        assert_eq!(node_row_count(&vault_path, IMAGE_NODE_A_ID), 0);
        assert_eq!(attachment_row_count(&vault_path, IMAGE_ATTACHMENT_A_ID), 0);
        assert_eq!(attachment_count(&vault_path), 0);
        assert_eq!(history_entry_count(&vault_path), 0);
        assert!(!asset_path.exists());
        assert!(asset_directory_entries(&vault_path).is_empty());
    }

    #[test]
    fn independent_image_node_asset_survives_undo_until_clear_history_reconciles() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        initialize_empty_test_vault(&vault_path);

        let (_imported, attachment) =
            import_single_independent_raw_image_node(&vault_path, "single.png");
        let asset_path = owned_asset_path(&vault_path, &attachment.relative_path);
        let asset_file_name = asset_file_name(&attachment.relative_path);
        assert!(asset_path.is_file());
        assert_eq!(attachment_count(&vault_path), 1);
        assert_eq!(
            attachment_history_change_count(&vault_path, IMAGE_ATTACHMENT_A_ID),
            1
        );
        assert_eq!(history_entry_count(&vault_path), 1);

        let undone = notes_undo(
            vault_path.clone(),
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("undo image node import");
        assert!(undone.workspace.nodes.is_empty());
        assert!(undone.workspace.attachments_by_node_id.is_empty());
        assert!(!undone.can_undo);
        assert!(undone.can_redo);
        assert_eq!(node_row_count(&vault_path, IMAGE_NODE_A_ID), 0);
        assert_eq!(attachment_row_count(&vault_path, IMAGE_ATTACHMENT_A_ID), 0);
        assert_eq!(attachment_count(&vault_path), 0);
        assert_eq!(history_entry_count(&vault_path), 1);
        assert_eq!(
            attachment_history_change_count(&vault_path, IMAGE_ATTACHMENT_A_ID),
            1
        );
        assert!(asset_path.is_file());
        assert_eq!(
            asset_directory_entries(&vault_path),
            vec![asset_file_name.clone()]
        );

        let redone = notes_redo(
            vault_path.clone(),
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("redo image node import");
        assert_imported_image_node(
            &redone.workspace,
            IMAGE_NODE_A_ID,
            IMAGE_ATTACHMENT_A_ID,
            None,
            "single.png",
        );
        assert!(redone.can_undo);
        assert!(!redone.can_redo);
        assert_eq!(node_row_count(&vault_path, IMAGE_NODE_A_ID), 1);
        assert_eq!(attachment_row_count(&vault_path, IMAGE_ATTACHMENT_A_ID), 1);
        assert_eq!(attachment_count(&vault_path), 1);
        assert_eq!(
            redone.workspace.attachments_by_node_id[IMAGE_NODE_A_ID]
                .iter()
                .map(|attachment| attachment.id.as_str())
                .collect::<Vec<_>>(),
            vec![IMAGE_ATTACHMENT_A_ID]
        );
        assert_eq!(
            redone.workspace.attachments_by_node_id[IMAGE_NODE_A_ID][0].relative_path,
            attachment.relative_path
        );
        assert!(asset_path.is_file());

        let undone_again = notes_undo(
            vault_path.clone(),
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("undo image node import before clearing history");
        assert!(undone_again.workspace.nodes.is_empty());
        assert!(undone_again.workspace.attachments_by_node_id.is_empty());
        assert_eq!(attachment_count(&vault_path), 0);
        assert_eq!(history_entry_count(&vault_path), 1);
        assert!(asset_path.is_file());

        let status = notes_clear_history(vault_path.clone(), SESSION_ID.to_string())
            .expect("clear image node history");
        assert!(!status.can_undo);
        assert!(!status.can_redo);
        assert_eq!(history_entry_count(&vault_path), 0);
        assert_eq!(
            attachment_history_change_count(&vault_path, IMAGE_ATTACHMENT_A_ID),
            0
        );
        assert_eq!(node_row_count(&vault_path, IMAGE_NODE_A_ID), 0);
        assert_eq!(attachment_row_count(&vault_path, IMAGE_ATTACHMENT_A_ID), 0);
        assert_eq!(attachment_count(&vault_path), 0);
        assert!(!asset_path.exists());
        assert!(asset_directory_entries(&vault_path).is_empty());
    }

    #[test]
    fn independent_image_node_duplicate_archive_restore_and_purge_keep_shared_asset_until_last_reference(
    ) {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        initialize_empty_test_vault(&vault_path);

        let (_imported, attachment) =
            import_single_independent_raw_image_node(&vault_path, "single.png");
        let expected_png = encoded_png(4, 3);
        let asset_path = owned_asset_path(&vault_path, &attachment.relative_path);
        let asset_file_name = asset_file_name(&attachment.relative_path);

        let duplicated =
            notes_duplicate_node(vault_path.clone(), IMAGE_NODE_A_ID.to_string(), None)
                .expect("duplicate image node");
        let image_node_ids = duplicated
            .workspace
            .nodes
            .iter()
            .filter(|node| node.node_kind == NoteNodeKind::Image)
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(image_node_ids.len(), 2);
        assert!(image_node_ids.contains(&IMAGE_NODE_A_ID));
        let duplicate_node_id = image_node_ids
            .iter()
            .copied()
            .find(|node_id| *node_id != IMAGE_NODE_A_ID)
            .expect("duplicated image node id");
        let original_attachment = assert_image_node_with_single_attachment(
            &duplicated.workspace,
            IMAGE_NODE_A_ID,
            "single.png",
            &attachment.relative_path,
        );
        assert_eq!(original_attachment.id, IMAGE_ATTACHMENT_A_ID);
        let duplicate_attachment = assert_image_node_with_single_attachment(
            &duplicated.workspace,
            duplicate_node_id,
            "single.png",
            &attachment.relative_path,
        );
        assert_ne!(duplicate_attachment.id, IMAGE_ATTACHMENT_A_ID);
        assert_eq!(
            duplicate_attachment.content_hash,
            original_attachment.content_hash
        );
        let duplicate_attachment_id = duplicate_attachment.id.clone();
        assert_eq!(attachment_count(&vault_path), 2);
        assert_eq!(
            asset_directory_entries(&vault_path),
            vec![asset_file_name.clone()]
        );
        assert!(asset_path.is_file());

        let archived = notes_archive_node(vault_path.clone(), IMAGE_NODE_A_ID.to_string(), None)
            .expect("archive image node");
        assert!(!archived
            .workspace
            .nodes
            .iter()
            .any(|node| node.id == IMAGE_NODE_A_ID));
        let archive = notes_load_workspace(vault_path.clone(), NotesWorkspaceScope::Archive)
            .expect("load archive workspace");
        assert_image_node_with_single_attachment(
            &archive,
            IMAGE_NODE_A_ID,
            "single.png",
            &attachment.relative_path,
        );
        assert_eq!(attachment_count(&vault_path), 2);
        assert_eq!(
            asset_directory_entries(&vault_path),
            vec![asset_file_name.clone()]
        );

        let unarchived =
            notes_unarchive_node(vault_path.clone(), IMAGE_NODE_A_ID.to_string(), None)
                .expect("unarchive image node");
        assert_image_node_with_single_attachment(
            &unarchived.workspace,
            IMAGE_NODE_A_ID,
            "single.png",
            &attachment.relative_path,
        );

        notes_soft_delete_node(vault_path.clone(), IMAGE_NODE_A_ID.to_string(), None)
            .expect("soft delete image node");
        let trash = notes_load_workspace(vault_path.clone(), NotesWorkspaceScope::Trash)
            .expect("load trash workspace");
        assert_image_node_with_single_attachment(
            &trash,
            IMAGE_NODE_A_ID,
            "single.png",
            &attachment.relative_path,
        );
        let restored = notes_restore_node(vault_path.clone(), IMAGE_NODE_A_ID.to_string(), None)
            .expect("restore image node");
        assert_image_node_with_single_attachment(
            &restored.workspace,
            IMAGE_NODE_A_ID,
            "single.png",
            &attachment.relative_path,
        );
        assert_image_node_with_single_attachment(
            &restored.workspace,
            duplicate_node_id,
            "single.png",
            &attachment.relative_path,
        );
        assert_eq!(attachment_count(&vault_path), 2);
        assert_eq!(
            asset_directory_entries(&vault_path),
            vec![asset_file_name.clone()]
        );
        assert!(asset_path.is_file());

        notes_soft_delete_node(vault_path.clone(), IMAGE_NODE_A_ID.to_string(), None)
            .expect("soft delete original image node before permanent purge");
        let after_original_purge =
            notes_empty_trash(vault_path.clone()).expect("permanently purge original image node");
        assert!(asset_path.is_file());
        assert!(!after_original_purge
            .nodes
            .iter()
            .any(|node| node.id == IMAGE_NODE_A_ID));
        let surviving_duplicate = assert_image_node_with_single_attachment(
            &after_original_purge,
            duplicate_node_id,
            "single.png",
            &attachment.relative_path,
        );
        assert_eq!(surviving_duplicate.id, duplicate_attachment_id);
        assert_eq!(surviving_duplicate.content_hash, attachment.content_hash);
        assert_eq!(node_row_count(&vault_path, IMAGE_NODE_A_ID), 0);
        assert_eq!(attachment_row_count(&vault_path, IMAGE_ATTACHMENT_A_ID), 0);
        assert_eq!(node_row_count(&vault_path, duplicate_node_id), 1);
        assert_eq!(
            attachment_row_count(&vault_path, &duplicate_attachment_id),
            1
        );
        assert_eq!(attachment_count(&vault_path), 1);
        assert_eq!(history_entry_count(&vault_path), 0);
        assert!(asset_path.is_file());
        assert_eq!(
            asset_directory_entries(&vault_path),
            vec![asset_file_name.clone()]
        );
        assert_eq!(
            fs::read(&asset_path).expect("read shared asset after original purge"),
            expected_png
        );
        assert_eq!(
            notes_read_attachment_bytes(vault_path.clone(), duplicate_attachment_id.clone())
                .expect("read duplicate attachment after original purge"),
            expected_png
        );

        notes_soft_delete_node(vault_path.clone(), duplicate_node_id.to_string(), None)
            .expect("soft delete duplicate image node before final purge");
        assert_eq!(
            attachment_row_count(&vault_path, &duplicate_attachment_id),
            1
        );
        assert!(asset_path.is_file());
        let after_final_purge =
            notes_empty_trash(vault_path.clone()).expect("permanently purge duplicate image node");
        assert!(after_final_purge.nodes.is_empty());
        assert!(after_final_purge.attachments_by_node_id.is_empty());
        assert_eq!(node_row_count(&vault_path, IMAGE_NODE_A_ID), 0);
        assert_eq!(node_row_count(&vault_path, duplicate_node_id), 0);
        assert_eq!(attachment_row_count(&vault_path, IMAGE_ATTACHMENT_A_ID), 0);
        assert_eq!(
            attachment_row_count(&vault_path, &duplicate_attachment_id),
            0
        );
        assert_eq!(attachment_count(&vault_path), 0);
        assert_eq!(history_entry_count(&vault_path), 0);
        assert!(!asset_path.exists());
        assert!(asset_directory_entries(&vault_path).is_empty());
    }

    #[test]
    fn image_node_batch_paths_create_ordered_nodes_and_replay_as_one_history_entry() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        initialize_empty_test_vault(&vault_path);
        seed_batch_node(&vault_path, ROOT_ID, None, None);
        seed_batch_node(&vault_path, BATCH_A_ID, None, Some(ROOT_ID));
        let first_source = temp_dir.path().join("first.png");
        let second_source = temp_dir.path().join("second.png");
        fs::write(&first_source, encoded_png(4, 3)).expect("write first image");
        fs::write(&second_source, encoded_png(5, 4)).expect("write second image");

        let imported = notes_import_image_node_paths_batch(
            vault_path.clone(),
            image_node_path_input(None, Some(ROOT_ID), &first_source, &second_source),
            Some(image_node_history_context()),
        )
        .expect("import image node path batch");

        assert_eq!(
            imported.imported_root_ids.as_deref(),
            Some(&[IMAGE_NODE_A_ID.to_string(), IMAGE_NODE_B_ID.to_string()][..])
        );
        assert_eq!(
            active_child_ids(&vault_path, None),
            vec![ROOT_ID, IMAGE_NODE_A_ID, IMAGE_NODE_B_ID, BATCH_A_ID]
        );
        assert_imported_image_node(
            &imported.workspace,
            IMAGE_NODE_A_ID,
            IMAGE_ATTACHMENT_A_ID,
            None,
            "first.png",
        );
        assert_imported_image_node(
            &imported.workspace,
            IMAGE_NODE_B_ID,
            IMAGE_ATTACHMENT_B_ID,
            None,
            "second.png",
        );
        assert_eq!(
            imported.history_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        let shared = acquire_notes_connection(&vault_path).expect("inspect image node history");
        let connection = lock_notes_connection(&shared).expect("lock image node history");
        let history_changes: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_history_changes WHERE entry_id = ?1",
                [REPLACEMENT_ENTRY_ID],
                |row| row.get(0),
            )
            .expect("count image node history changes");
        drop(connection);
        assert_eq!(history_entry_count(&vault_path), 1);
        assert_eq!(history_changes, 4);
        assert_eq!(asset_directory_entries(&vault_path).len(), 2);

        let undone = notes_undo(
            vault_path.clone(),
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("undo image node batch");
        assert_eq!(
            undone
                .workspace
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![ROOT_ID, BATCH_A_ID]
        );
        assert!(undone.workspace.attachments_by_node_id.is_empty());

        let redone = notes_redo(
            vault_path,
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("redo image node batch");
        assert_imported_image_node(
            &redone.workspace,
            IMAGE_NODE_A_ID,
            IMAGE_ATTACHMENT_A_ID,
            None,
            "first.png",
        );
        assert_imported_image_node(
            &redone.workspace,
            IMAGE_NODE_B_ID,
            IMAGE_ATTACHMENT_B_ID,
            None,
            "second.png",
        );
    }

    #[test]
    fn image_node_path_batch_reports_only_the_first_failing_filename_without_full_paths() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        let empty_source = temp_dir.path().join("first-empty.png");
        let missing_source = temp_dir.path().join("second-missing.png");
        fs::write(&empty_source, []).expect("write empty image");

        let error = notes_import_image_node_paths_batch(
            vault_path.clone(),
            image_node_path_input(None, None, &empty_source, &missing_source),
            Some(image_node_history_context()),
        )
        .expect_err("invalid image node path batch");

        assert!(
            error.contains(
                "first-empty.png: Notes attachment images must contain between 1 and 20971520 bytes."
            ),
            "{error}"
        );
        assert!(!error.contains("second-missing.png"), "{error}");
        assert!(
            !error.contains(temp_dir.path().to_string_lossy().as_ref()),
            "{error}"
        );
        assert_eq!(node_row_count(&vault_path, IMAGE_NODE_A_ID), 0);
        assert_eq!(attachment_count(&vault_path), 0);
        assert_eq!(history_entry_count(&vault_path), 0);
        assert!(asset_directory_entries(&vault_path).is_empty());
    }

    #[test]
    fn image_node_batch_raw_v2_creates_first_children_in_source_order() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        seed_batch_node(&vault_path, ROOT_ID, None, None);
        seed_batch_node(&vault_path, BATCH_A_ID, Some(ROOT_ID), None);
        let first = encoded_png(4, 3);
        let second = encoded_png(5, 4);
        let context = image_node_history_context();
        let envelope = raw_image_node_envelope(
            &vault_path,
            Some(ROOT_ID),
            None,
            &[
                (
                    IMAGE_NODE_A_ID,
                    IMAGE_ATTACHMENT_A_ID,
                    "raw-first.png",
                    "image/png",
                    &first,
                ),
                (
                    IMAGE_NODE_B_ID,
                    IMAGE_ATTACHMENT_B_ID,
                    "raw-second.png",
                    "image/png",
                    &second,
                ),
            ],
            Some(&context),
        );

        let imported =
            notes_import_image_node_bytes_body(&envelope).expect("import raw image node batch");

        assert_eq!(
            imported.imported_root_ids.as_deref(),
            Some(&[IMAGE_NODE_A_ID.to_string(), IMAGE_NODE_B_ID.to_string()][..])
        );
        assert_eq!(
            active_child_ids(&vault_path, Some(ROOT_ID)),
            vec![IMAGE_NODE_A_ID, IMAGE_NODE_B_ID, BATCH_A_ID]
        );
        assert_imported_image_node(
            &imported.workspace,
            IMAGE_NODE_A_ID,
            IMAGE_ATTACHMENT_A_ID,
            Some(ROOT_ID),
            "raw-first.png",
        );
        assert_imported_image_node(
            &imported.workspace,
            IMAGE_NODE_B_ID,
            IMAGE_ATTACHMENT_B_ID,
            Some(ROOT_ID),
            "raw-second.png",
        );
        assert_eq!(history_entry_count(&vault_path), 1);

        let mut legacy_v1 = envelope.clone();
        legacy_v1[..4].copy_from_slice(b"YNAB");
        legacy_v1[4] = 1;
        notes_import_image_node_bytes_body(&legacy_v1)
            .expect_err("legacy attachment v1 must not be reinterpreted");
        let mut legacy_magic_v2 = envelope;
        legacy_magic_v2[..4].copy_from_slice(b"YNAB");
        notes_import_image_node_bytes_body(&legacy_magic_v2)
            .expect_err("legacy attachment magic must not be reinterpreted at v2");
    }

    #[test]
    fn image_node_batch_path_retry_is_idempotent_and_rejects_mismatched_state() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        seed_batch_node(&vault_path, ROOT_ID, None, None);
        seed_batch_node(&vault_path, BATCH_A_ID, None, Some(ROOT_ID));
        let first_source = temp_dir.path().join("first.png");
        let second_source = temp_dir.path().join("second.png");
        fs::write(&first_source, encoded_png(4, 3)).expect("write first image");
        fs::write(&second_source, encoded_png(5, 4)).expect("write second image");
        let input = image_node_path_input(None, Some(ROOT_ID), &first_source, &second_source);
        let history_context = image_node_history_context();

        let committed = notes_import_image_node_paths_batch(
            vault_path.clone(),
            input.clone(),
            Some(history_context.clone()),
        )
        .expect("commit image node batch before response loss");
        let files_before_retry = asset_directory_entries(&vault_path);
        let mut stale_history = history_context.clone();
        stale_history.history_epoch = "stale-epoch".to_string();
        let stale_error = notes_import_image_node_paths_batch(
            vault_path.clone(),
            input.clone(),
            Some(stale_history),
        )
        .expect_err("committed image-node path retry with stale epoch");
        assert!(
            stale_error.to_lowercase().contains("epoch"),
            "{stale_error}"
        );
        assert_eq!(history_entry_count(&vault_path), 1);
        assert_eq!(asset_directory_entries(&vault_path), files_before_retry);
        fs::remove_file(&first_source).expect("move first source after committed response loss");
        fs::remove_file(&second_source).expect("move second source after committed response loss");
        inject_attachment_batch_fault(AttachmentBatchFault::ReturnAfterPublished(1));

        let retried = notes_import_image_node_paths_batch(
            vault_path.clone(),
            input.clone(),
            Some(history_context.clone()),
        )
        .expect("retry committed image node path batch");

        assert_eq!(retried, committed);
        assert_eq!(history_entry_count(&vault_path), 1);
        assert_eq!(asset_directory_entries(&vault_path), files_before_retry);
        assert_eq!(
            ATTACHMENT_BATCH_FAULT.with(|fault| fault.take()),
            Some(AttachmentBatchFault::ReturnAfterPublished(1)),
            "an idempotent retry must not enter publication"
        );

        let moved_source = temp_dir.path().join("moved.png");
        let mut moved_payload = input.clone();
        moved_payload.items[1].source_path = moved_source.to_string_lossy().into_owned();
        let moved_retry = notes_import_image_node_paths_batch(
            vault_path.clone(),
            moved_payload,
            Some(history_context.clone()),
        )
        .expect("committed retry must not reread moved source paths");
        assert_eq!(moved_retry, committed);

        let mut mismatched_anchor = input.clone();
        mismatched_anchor.after_id = Some(BATCH_A_ID.to_string());
        let error = notes_import_image_node_paths_batch(
            vault_path.clone(),
            mismatched_anchor,
            Some(history_context.clone()),
        )
        .expect_err("same IDs with mismatched anchor");
        assert!(error.contains("inconsistent"), "{error}");

        let mut mismatched_history = history_context;
        mismatched_history.command_kind = "differentImageImport".to_string();
        let error = notes_import_image_node_paths_batch(
            vault_path.clone(),
            input,
            Some(mismatched_history),
        )
        .expect_err("same IDs with mismatched history context");
        assert!(error.contains("inconsistent"), "{error}");
        assert_eq!(history_entry_count(&vault_path), 1);
        assert_eq!(asset_directory_entries(&vault_path), files_before_retry);
    }

    #[cfg(unix)]
    #[test]
    fn image_node_batch_path_retry_rejects_database_replacement_before_early_return() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path = vault_path.to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        seed_batch_node(&vault_path, ROOT_ID, None, None);
        let first_source = temp_dir.path().join("first.png");
        let second_source = temp_dir.path().join("second.png");
        fs::write(&first_source, encoded_png(4, 3)).expect("write first image");
        fs::write(&second_source, encoded_png(5, 4)).expect("write second image");
        let input = image_node_path_input(None, Some(ROOT_ID), &first_source, &second_source);
        let history_context = image_node_history_context();
        notes_import_image_node_paths_batch(
            vault_path.clone(),
            input.clone(),
            Some(history_context.clone()),
        )
        .expect("commit image node batch before retry");

        let replacement_vault = temp_dir.path().join("replacement-vault");
        let replacement_vault = replacement_vault.to_string_lossy().into_owned();
        let replacement = connect_notes_db(&replacement_vault).expect("open replacement database");
        replacement
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .expect("checkpoint replacement database");
        drop(replacement);
        let live_database = crate::notes::repository::notes_db_path(&vault_path);
        let replacement_database = crate::notes::repository::notes_db_path(&replacement_vault);
        let moved_directory = live_database
            .parent()
            .expect("live metadata directory")
            .join("moved-before-image-retry-return");
        inject_image_node_retry_before_return_once(move || {
            fs::create_dir(&moved_directory).expect("create moved database directory");
            for suffix in ["", "-wal", "-shm"] {
                let mut live = live_database.as_os_str().to_os_string();
                live.push(suffix);
                let live = PathBuf::from(live);
                if live.exists() {
                    let moved = moved_directory.join(live.file_name().expect("SQLite set name"));
                    fs::rename(live, moved).expect("move live SQLite set member");
                }
                let mut replacement = replacement_database.as_os_str().to_os_string();
                replacement.push(suffix);
                let replacement = PathBuf::from(replacement);
                if replacement.exists() {
                    let mut destination = live_database.as_os_str().to_os_string();
                    destination.push(suffix);
                    fs::rename(replacement, PathBuf::from(destination))
                        .expect("install replacement SQLite set member");
                }
            }
        });

        let result = notes_import_image_node_paths_batch(vault_path, input, Some(history_context));

        assert!(
            result.is_err(),
            "an idempotent retry must revalidate before returning committed state"
        );
    }

    #[test]
    fn image_node_batch_path_retry_reconstructs_rebalanced_sibling_delta() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        initialize_empty_test_vault(&vault_path);
        seed_batch_node(&vault_path, ROOT_ID, None, None);
        seed_batch_node(&vault_path, BATCH_A_ID, None, Some(ROOT_ID));
        {
            let shared = acquire_notes_connection(&vault_path).expect("open rebalance vault");
            let connection = lock_notes_connection(&shared).expect("lock Notes connection");
            connection
                .execute(
                    "UPDATE notes_nodes SET \
                       sort_key = CASE id WHEN ?1 THEN 1024 WHEN ?2 THEN 1025 END, \
                       updated_at = '2026-07-10T00:00:00.000Z' \
                     WHERE id IN (?1, ?2)",
                    params![ROOT_ID, BATCH_A_ID],
                )
                .expect("force adjacent sibling sort keys");
        }
        let first_source = temp_dir.path().join("first.png");
        let second_source = temp_dir.path().join("second.png");
        fs::write(&first_source, encoded_png(4, 3)).expect("write first image");
        fs::write(&second_source, encoded_png(5, 4)).expect("write second image");
        let input = image_node_path_input(None, Some(ROOT_ID), &first_source, &second_source);
        let history_context = image_node_history_context();

        let committed = notes_import_image_node_paths_batch(
            vault_path.clone(),
            input.clone(),
            Some(history_context.clone()),
        )
        .expect("commit rebalancing image node batch before response loss");

        let changed_node_ids = committed
            .changed_nodes
            .as_ref()
            .expect("journaled changed nodes")
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            changed_node_ids,
            vec![ROOT_ID, BATCH_A_ID, IMAGE_NODE_A_ID, IMAGE_NODE_B_ID]
        );
        {
            let shared = acquire_notes_connection(&vault_path).expect("inspect rebalance history");
            let connection = lock_notes_connection(&shared).expect("lock Notes connection");
            let change_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_history_changes WHERE entry_id = ?1",
                    [&history_context.entry_id],
                    |row| row.get(0),
                )
                .expect("count rebalanced image history changes");
            assert_eq!(change_count, 6);
        }
        let files_before_retry = asset_directory_entries(&vault_path);
        inject_attachment_batch_fault(AttachmentBatchFault::ReturnAfterPublished(1));

        let retried = notes_import_image_node_paths_batch(
            vault_path.clone(),
            input.clone(),
            Some(history_context.clone()),
        )
        .expect("retry committed rebalancing image node batch");

        assert_eq!(retried, committed);
        assert_eq!(history_entry_count(&vault_path), 1);
        assert_eq!(asset_directory_entries(&vault_path), files_before_retry);
        assert_eq!(
            ATTACHMENT_BATCH_FAULT.with(|fault| fault.take()),
            Some(AttachmentBatchFault::ReturnAfterPublished(1)),
            "an idempotent rebalancing retry must not enter publication"
        );

        let mut mismatched_anchor = input.clone();
        mismatched_anchor.after_id = Some(BATCH_A_ID.to_string());
        let error = notes_import_image_node_paths_batch(
            vault_path.clone(),
            mismatched_anchor,
            Some(history_context.clone()),
        )
        .expect_err("rebalanced retry with mismatched anchor");
        assert!(error.contains("inconsistent"), "{error}");

        {
            let shared = acquire_notes_connection(&vault_path).expect("open history for tampering");
            let connection = lock_notes_connection(&shared).expect("lock Notes connection");
            connection
                .execute(
                    "UPDATE notes_history_changes \
                     SET before_json = json_set(\
                       before_json, '$.deleted_batch_id', \
                       'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'\
                     ) \
                     WHERE entry_id = ?1 AND table_name = 'notes_nodes' AND row_id = ?2",
                    params![history_context.entry_id, ROOT_ID],
                )
                .expect("tamper unrelated rebalance audit field");
        }
        inject_attachment_batch_fault(AttachmentBatchFault::ReturnAfterPublished(1));
        let error =
            notes_import_image_node_paths_batch(vault_path.clone(), input, Some(history_context))
                .expect_err("retry with unrelated rebalance audit change");
        assert!(error.contains("inconsistent"), "{error}");
        assert_eq!(
            ATTACHMENT_BATCH_FAULT.with(|fault| fault.take()),
            Some(AttachmentBatchFault::ReturnAfterPublished(1)),
            "an inconsistent rebalance retry must not enter publication"
        );
        assert_eq!(history_entry_count(&vault_path), 1);
        assert_eq!(asset_directory_entries(&vault_path), files_before_retry);
    }

    #[test]
    fn image_node_batch_raw_retry_is_idempotent_and_rejects_mismatched_state() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        seed_batch_node(&vault_path, ROOT_ID, None, None);
        seed_batch_node(&vault_path, BATCH_A_ID, None, Some(ROOT_ID));
        let first = encoded_png(4, 3);
        let second = encoded_png(5, 4);
        let history_context = image_node_history_context();
        let envelope = raw_image_node_envelope(
            &vault_path,
            None,
            Some(ROOT_ID),
            &[
                (
                    IMAGE_NODE_A_ID,
                    IMAGE_ATTACHMENT_A_ID,
                    "first.png",
                    "image/png",
                    &first,
                ),
                (
                    IMAGE_NODE_B_ID,
                    IMAGE_ATTACHMENT_B_ID,
                    "second.png",
                    "image/png",
                    &second,
                ),
            ],
            Some(&history_context),
        );

        let committed = notes_import_image_node_bytes_body(&envelope)
            .expect("commit raw image node batch before response loss");
        let files_before_retry = asset_directory_entries(&vault_path);
        let mut stale_history = history_context.clone();
        stale_history.history_epoch = "stale-epoch".to_string();
        let stale_envelope = raw_image_node_envelope(
            &vault_path,
            None,
            Some(ROOT_ID),
            &[
                (
                    IMAGE_NODE_A_ID,
                    IMAGE_ATTACHMENT_A_ID,
                    "first.png",
                    "image/png",
                    &first,
                ),
                (
                    IMAGE_NODE_B_ID,
                    IMAGE_ATTACHMENT_B_ID,
                    "second.png",
                    "image/png",
                    &second,
                ),
            ],
            Some(&stale_history),
        );
        let stale_error = notes_import_image_node_bytes_body(&stale_envelope)
            .expect_err("committed raw image-node retry with stale epoch");
        assert!(
            stale_error.to_lowercase().contains("epoch"),
            "{stale_error}"
        );
        assert_eq!(history_entry_count(&vault_path), 1);
        assert_eq!(asset_directory_entries(&vault_path), files_before_retry);
        inject_attachment_batch_fault(AttachmentBatchFault::ReturnAfterPublished(1));
        let retried = notes_import_image_node_bytes_body(&envelope)
            .expect("retry committed raw image node batch");

        assert_eq!(retried, committed);
        assert_eq!(history_entry_count(&vault_path), 1);
        assert_eq!(asset_directory_entries(&vault_path), files_before_retry);
        assert_eq!(
            ATTACHMENT_BATCH_FAULT.with(|fault| fault.take()),
            Some(AttachmentBatchFault::ReturnAfterPublished(1)),
            "an idempotent retry must not enter publication"
        );

        let mismatched = encoded_png(6, 5);
        let mismatched_payload = raw_image_node_envelope(
            &vault_path,
            None,
            Some(ROOT_ID),
            &[
                (
                    IMAGE_NODE_A_ID,
                    IMAGE_ATTACHMENT_A_ID,
                    "first.png",
                    "image/png",
                    &first,
                ),
                (
                    IMAGE_NODE_B_ID,
                    IMAGE_ATTACHMENT_B_ID,
                    "second.png",
                    "image/png",
                    &mismatched,
                ),
            ],
            Some(&history_context),
        );
        let error = notes_import_image_node_bytes_body(&mismatched_payload)
            .expect_err("raw same IDs with mismatched payload");
        assert!(error.contains("inconsistent"), "{error}");

        let mismatched_anchor = raw_image_node_envelope(
            &vault_path,
            None,
            Some(BATCH_A_ID),
            &[
                (
                    IMAGE_NODE_A_ID,
                    IMAGE_ATTACHMENT_A_ID,
                    "first.png",
                    "image/png",
                    &first,
                ),
                (
                    IMAGE_NODE_B_ID,
                    IMAGE_ATTACHMENT_B_ID,
                    "second.png",
                    "image/png",
                    &second,
                ),
            ],
            Some(&history_context),
        );
        let error = notes_import_image_node_bytes_body(&mismatched_anchor)
            .expect_err("raw same IDs with mismatched anchor");
        assert!(error.contains("inconsistent"), "{error}");

        let mut mismatched_history = history_context;
        mismatched_history.command_kind = "differentImageImport".to_string();
        let mismatched_context = raw_image_node_envelope(
            &vault_path,
            None,
            Some(ROOT_ID),
            &[
                (
                    IMAGE_NODE_A_ID,
                    IMAGE_ATTACHMENT_A_ID,
                    "first.png",
                    "image/png",
                    &first,
                ),
                (
                    IMAGE_NODE_B_ID,
                    IMAGE_ATTACHMENT_B_ID,
                    "second.png",
                    "image/png",
                    &second,
                ),
            ],
            Some(&mismatched_history),
        );
        let error = notes_import_image_node_bytes_body(&mismatched_context)
            .expect_err("raw same IDs with mismatched history context");
        assert!(error.contains("inconsistent"), "{error}");
        assert_eq!(history_entry_count(&vault_path), 1);
        assert_eq!(asset_directory_entries(&vault_path), files_before_retry);
    }

    #[test]
    fn image_node_batch_rejects_fresh_history_collision_before_publication() {
        for (label, colliding_context) in [
            (
                "same-session different command",
                NotesHistoryContext {
                    session_id: SESSION_ID.to_string(),
                    history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
                    entry_id: REPLACEMENT_ENTRY_ID.to_string(),
                    command_kind: "importImageNodes".to_string(),
                },
            ),
            (
                "different-session same command",
                NotesHistoryContext {
                    session_id: "99999999-9999-4999-8999-999999999998".to_string(),
                    history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
                    entry_id: REPLACEMENT_ENTRY_ID.to_string(),
                    command_kind: "importImageNodes".to_string(),
                },
            ),
        ] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let vault_path = temp_dir.path().to_string_lossy().into_owned();
            notes_initialize(vault_path.clone()).expect("initialize");
            seed_batch_node(&vault_path, ROOT_ID, None, None);
            notes_update_node(
                vault_path.clone(),
                UpdateNodeInput {
                    id: ROOT_ID.to_string(),
                    title: format!("Root updated for {label}"),
                    note: String::new(),
                    image_offset_utf16: 0,
                },
                Some(NotesHistoryContext {
                    session_id: SESSION_ID.to_string(),
                    history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
                    entry_id: REPLACEMENT_ENTRY_ID.to_string(),
                    command_kind: "updateNode".to_string(),
                }),
            )
            .expect("seed unrelated latest history entry");
            let first_source = temp_dir.path().join("first.png");
            let second_source = temp_dir.path().join("second.png");
            fs::write(&first_source, encoded_png(4, 3)).expect("write first image");
            fs::write(&second_source, encoded_png(5, 4)).expect("write second image");
            inject_attachment_batch_fault(AttachmentBatchFault::ReturnAfterPublished(1));

            let error = notes_import_image_node_paths_batch(
                vault_path.clone(),
                image_node_path_input(None, Some(ROOT_ID), &first_source, &second_source),
                Some(colliding_context),
            )
            .expect_err(label);

            assert!(error.to_lowercase().contains("history"), "{label}: {error}");
            assert_eq!(
                ATTACHMENT_BATCH_FAULT.with(|fault| fault.take()),
                Some(AttachmentBatchFault::ReturnAfterPublished(1)),
                "{label}: fresh collision must be rejected before publication"
            );
            assert_eq!(history_entry_count(&vault_path), 1, "{label}");
            assert!(asset_directory_entries(&vault_path).is_empty(), "{label}");
        }
    }

    #[test]
    fn image_node_batch_path_retry_rejects_missing_committed_asset() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        seed_batch_node(&vault_path, ROOT_ID, None, None);
        let first_source = temp_dir.path().join("first.png");
        let second_source = temp_dir.path().join("second.png");
        fs::write(&first_source, encoded_png(4, 3)).expect("write first image");
        fs::write(&second_source, encoded_png(5, 4)).expect("write second image");
        let input = image_node_path_input(None, Some(ROOT_ID), &first_source, &second_source);
        let history_context = image_node_history_context();
        let committed = notes_import_image_node_paths_batch(
            vault_path.clone(),
            input.clone(),
            Some(history_context.clone()),
        )
        .expect("commit image node batch before response loss");
        let attachment = &committed.workspace.attachments_by_node_id[IMAGE_NODE_A_ID][0];
        let missing_asset = owned_asset_path(&vault_path, &attachment.relative_path);
        fs::remove_file(&missing_asset).expect("remove committed backing asset");
        inject_attachment_batch_fault(AttachmentBatchFault::ReturnAfterPublished(1));

        let error =
            notes_import_image_node_paths_batch(vault_path.clone(), input, Some(history_context))
                .expect_err("missing committed asset");

        assert!(
            error.contains("Notes attachment") || error.contains("asset"),
            "{error}"
        );
        assert!(!missing_asset.exists());
        assert_eq!(
            ATTACHMENT_BATCH_FAULT.with(|fault| fault.take()),
            Some(AttachmentBatchFault::ReturnAfterPublished(1)),
            "missing committed asset retry must not enter publication"
        );
    }

    #[test]
    fn image_node_batch_raw_retry_rejects_corrupt_asset_without_repairing_from_body() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        seed_batch_node(&vault_path, ROOT_ID, None, None);
        let first = encoded_png(4, 3);
        let second = encoded_png(5, 4);
        let corrupt = encoded_png(9, 7);
        let history_context = image_node_history_context();
        let envelope = raw_image_node_envelope(
            &vault_path,
            None,
            Some(ROOT_ID),
            &[
                (
                    IMAGE_NODE_A_ID,
                    IMAGE_ATTACHMENT_A_ID,
                    "first.png",
                    "image/png",
                    &first,
                ),
                (
                    IMAGE_NODE_B_ID,
                    IMAGE_ATTACHMENT_B_ID,
                    "second.png",
                    "image/png",
                    &second,
                ),
            ],
            Some(&history_context),
        );
        let committed = notes_import_image_node_bytes_body(&envelope)
            .expect("commit raw image node batch before response loss");
        let attachment = &committed.workspace.attachments_by_node_id[IMAGE_NODE_A_ID][0];
        let asset_path = owned_asset_path(&vault_path, &attachment.relative_path);
        fs::write(&asset_path, &corrupt).expect("corrupt committed backing asset");
        inject_attachment_batch_fault(AttachmentBatchFault::ReturnAfterPublished(1));

        let error =
            notes_import_image_node_bytes_body(&envelope).expect_err("corrupt committed asset");

        assert!(error.contains("content hash"), "{error}");
        assert_eq!(
            fs::read(&asset_path).expect("read corrupt asset after rejected retry"),
            corrupt,
            "raw retry must not silently repair committed corrupt bytes"
        );
        assert_eq!(
            ATTACHMENT_BATCH_FAULT.with(|fault| fault.take()),
            Some(AttachmentBatchFault::ReturnAfterPublished(1)),
            "corrupt committed asset retry must not enter publication"
        );
    }

    #[test]
    fn image_node_batch_paths_require_valid_history_before_storage() {
        for history_context in [
            None,
            Some(NotesHistoryContext {
                session_id: SESSION_ID.to_string(),
                history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
                entry_id: "invalid".to_string(),
                command_kind: "importImageNodes".to_string(),
            }),
        ] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let vault_path = temp_dir.path().to_string_lossy().into_owned();
            let first_source = temp_dir.path().join("first.png");
            let second_source = temp_dir.path().join("second.png");
            fs::write(&first_source, encoded_png(4, 3)).expect("write first image");
            fs::write(&second_source, encoded_png(5, 4)).expect("write second image");

            let error = notes_import_image_node_paths_batch(
                vault_path.clone(),
                image_node_path_input(None, None, &first_source, &second_source),
                history_context,
            )
            .expect_err("image node paths require valid history");

            assert!(error.to_lowercase().contains("history"), "{error}");
            let metadata = crate::metadata_dir(&vault_path);
            assert!(!metadata.join("notes.sqlite").exists());
            assert!(!metadata.join("notes-assets").exists());
        }
    }

    #[test]
    fn image_node_batch_raw_requires_valid_history_before_storage() {
        for history_context in [
            None,
            Some(NotesHistoryContext {
                session_id: SESSION_ID.to_string(),
                history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
                entry_id: "invalid".to_string(),
                command_kind: "importImageNodes".to_string(),
            }),
        ] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let vault_path = temp_dir.path().to_string_lossy().into_owned();
            let first = encoded_png(4, 3);
            let second = encoded_png(5, 4);
            let envelope = raw_image_node_envelope(
                &vault_path,
                None,
                None,
                &[
                    (
                        IMAGE_NODE_A_ID,
                        IMAGE_ATTACHMENT_A_ID,
                        "first.png",
                        "image/png",
                        &first,
                    ),
                    (
                        IMAGE_NODE_B_ID,
                        IMAGE_ATTACHMENT_B_ID,
                        "second.png",
                        "image/png",
                        &second,
                    ),
                ],
                history_context.as_ref(),
            );

            let error = notes_import_image_node_bytes_body(&envelope)
                .expect_err("raw image nodes require valid history");

            assert!(error.to_lowercase().contains("history"), "{error}");
            let metadata = crate::metadata_dir(&vault_path);
            assert!(!metadata.join("notes.sqlite").exists());
            assert!(!metadata.join("notes-assets").exists());
        }
    }

    #[test]
    fn image_node_batch_invalid_second_image_fails_before_publication() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        initialize_empty_test_vault(&vault_path);
        seed_batch_node(&vault_path, ROOT_ID, None, None);
        let first_source = temp_dir.path().join("first.png");
        let invalid_source = temp_dir.path().join("invalid.png");
        fs::write(&first_source, encoded_png(4, 3)).expect("write first image");
        fs::write(&invalid_source, b"not an image").expect("write invalid image");

        let error = notes_import_image_node_paths_batch(
            vault_path.clone(),
            image_node_path_input(None, Some(ROOT_ID), &first_source, &invalid_source),
            Some(image_node_history_context()),
        )
        .expect_err("invalid second image");

        assert!(error.contains("invalid.png"), "{error}");
        let shared = acquire_notes_connection(&vault_path).expect("inspect invalid image batch");
        let connection = lock_notes_connection(&shared).expect("lock invalid image batch history");
        let counts: (i64, i64, i64) = connection
            .query_row(
                "SELECT \
                   (SELECT COUNT(*) FROM notes_nodes), \
                   (SELECT COUNT(*) FROM notes_attachments), \
                   (SELECT COUNT(*) FROM notes_history_entries)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("count invalid image batch rows");
        assert_eq!(counts, (1, 0, 0));
        assert!(asset_directory_entries(&vault_path).is_empty());
    }

    #[test]
    fn image_node_batch_publication_and_transaction_failures_leave_no_orphans() {
        for fault in [
            AttachmentBatchFault::ReturnAfterPublished(1),
            AttachmentBatchFault::ReturnBeforeCommit,
        ] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let vault_path = temp_dir.path().to_string_lossy().into_owned();
            initialize_empty_test_vault(&vault_path);
            seed_batch_node(&vault_path, ROOT_ID, None, None);
            let first_source = temp_dir.path().join("first.png");
            let second_source = temp_dir.path().join("second.png");
            fs::write(&first_source, encoded_png(4, 3)).expect("write first image");
            fs::write(&second_source, encoded_png(5, 4)).expect("write second image");
            inject_attachment_batch_fault(fault);

            notes_import_image_node_paths_batch(
                vault_path.clone(),
                image_node_path_input(None, Some(ROOT_ID), &first_source, &second_source),
                Some(image_node_history_context()),
            )
            .expect_err("injected image node batch failure");

            let shared = acquire_notes_connection(&vault_path).expect("inspect failed image batch");
            let connection =
                lock_notes_connection(&shared).expect("lock failed image batch history");
            let counts: (i64, i64, i64) = connection
                .query_row(
                    "SELECT \
                       (SELECT COUNT(*) FROM notes_nodes), \
                       (SELECT COUNT(*) FROM notes_attachments), \
                       (SELECT COUNT(*) FROM notes_history_entries)",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .expect("count failed image batch rows");
            assert_eq!(counts, (1, 0, 0), "{fault:?}");
            assert!(asset_directory_entries(&vault_path).is_empty(), "{fault:?}");
            let storage = AttachmentStorageLease::acquire(&vault_path).expect("inspect marker");
            assert!(!storage.reconciliation_needed().expect("marker state"));
        }
    }

    #[test]
    fn image_node_batch_rejects_duplicate_and_stale_ids_and_anchors_before_publication() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize");
        seed_batch_node(&vault_path, ROOT_ID, None, None);
        seed_batch_node(&vault_path, BATCH_A_ID, Some(ROOT_ID), None);
        seed_batch_node(&vault_path, BATCH_B_ID, None, Some(ROOT_ID));
        let first_source = temp_dir.path().join("first.png");
        let second_source = temp_dir.path().join("second.png");
        fs::write(&first_source, encoded_png(4, 3)).expect("write first image");
        fs::write(&second_source, encoded_png(5, 4)).expect("write second image");

        let mut duplicate_node =
            image_node_path_input(None, Some(ROOT_ID), &first_source, &second_source);
        duplicate_node.items[1].node_id = IMAGE_NODE_A_ID.to_string();
        assert!(notes_import_image_node_paths_batch(
            vault_path.clone(),
            duplicate_node,
            Some(image_node_history_context()),
        )
        .is_err());

        let mut duplicate_attachment =
            image_node_path_input(None, Some(ROOT_ID), &first_source, &second_source);
        duplicate_attachment.items[1].attachment_id = IMAGE_ATTACHMENT_A_ID.to_string();
        assert!(notes_import_image_node_paths_batch(
            vault_path.clone(),
            duplicate_attachment,
            Some(image_node_history_context()),
        )
        .is_err());

        let mut stale_node =
            image_node_path_input(None, Some(ROOT_ID), &first_source, &second_source);
        stale_node.items[0].node_id = ROOT_ID.to_string();
        assert!(notes_import_image_node_paths_batch(
            vault_path.clone(),
            stale_node,
            Some(image_node_history_context()),
        )
        .is_err());

        let connection = connect_notes_db(&vault_path).expect("seed stale attachment ID");
        let stale_attachment_id = insert_limit_attachment_metadata(&connection, 0, ROOT_ID);
        drop(connection);
        let mut stale_attachment =
            image_node_path_input(None, Some(ROOT_ID), &first_source, &second_source);
        stale_attachment.items[0].attachment_id = stale_attachment_id;
        assert!(notes_import_image_node_paths_batch(
            vault_path.clone(),
            stale_attachment,
            Some(image_node_history_context()),
        )
        .is_err());

        for (parent_id, after_id) in [
            (Some(BATCH_B_ID), Some(BATCH_A_ID)),
            (None, Some(BATCH_MISSING_ID)),
            (Some(BATCH_MISSING_ID), None),
        ] {
            assert!(notes_import_image_node_paths_batch(
                vault_path.clone(),
                image_node_path_input(parent_id, after_id, &first_source, &second_source),
                Some(image_node_history_context()),
            )
            .is_err());
        }

        let connection = connect_notes_db(&vault_path).expect("inspect rejected identities");
        let image_nodes: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_nodes WHERE node_kind = 'image'",
                [],
                |row| row.get(0),
            )
            .expect("count rejected image nodes");
        let attachment_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("count retained stale attachment");
        assert_eq!(image_nodes, 0);
        assert_eq!(attachment_count, 1);
        assert_eq!(history_entry_count(&vault_path), 0);
        assert!(asset_directory_entries(&vault_path).is_empty());
    }

    #[test]
    fn image_node_path_batch_rejects_shared_ids_without_side_effects() {
        for overlap in ["same item", "cross item"] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let vault_path = temp_dir.path().to_string_lossy().into_owned();
            initialize_empty_test_vault(&vault_path);
            let first_source = temp_dir.path().join("first.png");
            let second_source = temp_dir.path().join("second.png");
            fs::write(&first_source, encoded_png(4, 3)).expect("write first image");
            fs::write(&second_source, encoded_png(5, 4)).expect("write second image");
            let mut input = image_node_path_input(None, None, &first_source, &second_source);
            if overlap == "same item" {
                input.items[0].attachment_id = IMAGE_NODE_A_ID.to_string();
            } else {
                input.items[1].node_id = IMAGE_ATTACHMENT_A_ID.to_string();
            }

            let error = notes_import_image_node_paths_batch(
                vault_path.clone(),
                input,
                Some(image_node_history_context()),
            )
            .expect_err(overlap);

            assert!(
                error.contains("both a node and attachment ID"),
                "{overlap}: {error}"
            );
            let shared =
                acquire_notes_connection(&vault_path).expect("inspect rejected path batch");
            let connection =
                lock_notes_connection(&shared).expect("lock rejected path batch history");
            let counts: (i64, i64, i64, i64) = connection
                .query_row(
                    "SELECT \
                       (SELECT COUNT(*) FROM notes_nodes), \
                       (SELECT COUNT(*) FROM notes_attachments), \
                       (SELECT COUNT(*) FROM notes_history_entries), \
                       (SELECT COUNT(*) FROM notes_history_changes)",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .expect("count rejected path batch rows");
            assert_eq!(counts, (0, 0, 0, 0), "{overlap}");
            assert!(asset_directory_entries(&vault_path).is_empty(), "{overlap}");
        }
    }

    #[test]
    fn image_node_raw_batch_rejects_shared_ids_without_side_effects() {
        for overlap in ["same item", "cross item"] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let vault_path = temp_dir.path().to_string_lossy().into_owned();
            initialize_empty_test_vault(&vault_path);
            let first = encoded_png(4, 3);
            let second = encoded_png(5, 4);
            let second_node_id = if overlap == "same item" {
                IMAGE_NODE_B_ID
            } else {
                IMAGE_ATTACHMENT_A_ID
            };
            let first_attachment_id = if overlap == "same item" {
                IMAGE_NODE_A_ID
            } else {
                IMAGE_ATTACHMENT_A_ID
            };
            let envelope = raw_image_node_envelope(
                &vault_path,
                None,
                None,
                &[
                    (
                        IMAGE_NODE_A_ID,
                        first_attachment_id,
                        "raw-first.png",
                        "image/png",
                        &first,
                    ),
                    (
                        second_node_id,
                        IMAGE_ATTACHMENT_B_ID,
                        "raw-second.png",
                        "image/png",
                        &second,
                    ),
                ],
                Some(&image_node_history_context()),
            );

            let error = notes_import_image_node_bytes_body(&envelope).expect_err(overlap);

            assert!(
                error.contains("both a node and attachment ID"),
                "{overlap}: {error}"
            );
            let shared = acquire_notes_connection(&vault_path).expect("inspect rejected raw batch");
            let connection =
                lock_notes_connection(&shared).expect("lock rejected raw batch history");
            let counts: (i64, i64, i64, i64) = connection
                .query_row(
                    "SELECT \
                       (SELECT COUNT(*) FROM notes_nodes), \
                       (SELECT COUNT(*) FROM notes_attachments), \
                       (SELECT COUNT(*) FROM notes_history_entries), \
                       (SELECT COUNT(*) FROM notes_history_changes)",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .expect("count rejected raw batch rows");
            assert_eq!(counts, (0, 0, 0, 0), "{overlap}");
            assert!(asset_directory_entries(&vault_path).is_empty(), "{overlap}");
        }
    }

    #[test]
    fn attachment_batch_performance_probe_records_each_stage_once_and_resets() {
        assert!(!attachment_batch_performance_probe_is_active());
        let probe = AttachmentBatchPerformanceProbeGuard::enable();
        assert!(attachment_batch_performance_probe_is_active());
        assert!(
            !std::thread::spawn(attachment_batch_performance_probe_is_active)
                .join()
                .expect("inspect probe on another thread")
        );

        {
            let _timer = AttachmentBatchPerformanceStageTimer::start(
                AttachmentBatchPerformanceStage::Prepare,
            );
        }
        {
            let _timer = AttachmentBatchPerformanceStageTimer::start(
                AttachmentBatchPerformanceStage::Publish,
            );
        }
        start_attachment_batch_commit_stage();
        assert_eq!(
            finish_attachment_batch_commit_stage(true),
            Err(
                "successful attachment batch commit timing must finish after the history wrapper returns"
            )
        );
        assert!(!probe.commit_is_pending());
        assert!(probe.samples().commit.is_empty());

        start_attachment_batch_commit_stage();
        finish_attachment_batch_commit_stage(false).expect("clear failed commit timing");
        assert!(!probe.commit_is_pending());
        assert!(probe.samples().commit.is_empty());

        start_attachment_batch_commit_stage();
        mark_attachment_batch_history_wrapper_returned();
        finish_attachment_batch_commit_stage(true).expect("finish successful commit timing");

        let samples = probe.samples();
        assert_eq!(samples.prepare.len(), 1);
        assert_eq!(samples.publish.len(), 1);
        assert_eq!(samples.commit.len(), 1);
        assert_eq!(samples.commit_wrapper_returns, 1);
        assert!(!probe.commit_is_pending());
        drop(probe);
        assert!(!attachment_batch_performance_probe_is_active());

        let fresh_probe = AttachmentBatchPerformanceProbeGuard::enable();
        let fresh_samples = fresh_probe.samples();
        assert!(fresh_samples.prepare.is_empty());
        assert!(fresh_samples.publish.is_empty());
        assert!(fresh_samples.commit.is_empty());
        assert_eq!(fresh_samples.commit_wrapper_returns, 0);
        assert!(!fresh_probe.commit_is_pending());
        drop(fresh_probe);
        assert!(!attachment_batch_performance_probe_is_active());
    }

    #[test]
    #[ignore = "release-only performance measurement"]
    fn notes_attachment_batch_performance() {
        const IMAGE_COUNT: usize = 128;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        seed_attachment_batch_node(&vault_path);

        let mut expected_ids = Vec::with_capacity(IMAGE_COUNT);
        let mut expected_names = Vec::with_capacity(IMAGE_COUNT);
        let mut attachments = Vec::with_capacity(IMAGE_COUNT);
        for index in 0..IMAGE_COUNT {
            let id = format!("10000000-0000-4000-8000-{index:012x}");
            let original_name = format!("source-{index:03}.png");
            let source_path = temp_dir.path().join(&original_name);
            fs::write(&source_path, encoded_png(index as u32 + 1, 1))
                .expect("write performance image");
            expected_ids.push(id.clone());
            expected_names.push(original_name);
            attachments.push(ImportAttachmentPathItem {
                id,
                source_path: source_path.to_string_lossy().into_owned(),
            });
        }
        assert_eq!(attachments.len(), IMAGE_COUNT);

        assert!(!attachment_batch_performance_probe_is_active());
        let probe = AttachmentBatchPerformanceProbeGuard::enable();
        let total_started = std::time::Instant::now();
        let imported = notes_import_attachment_paths_batch(
            vault_path.clone(),
            ImportAttachmentPathBatchInput {
                node_id: ROOT_ID.to_string(),
                attachments,
                initial_max_display_width: 480,
            },
            Some(batch_history_context()),
        )
        .expect("import 128-image path batch");
        let samples = probe.samples();
        assert_eq!(samples.prepare.len(), 1, "prepare stage sample count");
        assert_eq!(samples.publish.len(), 1, "publish stage sample count");
        assert_eq!(samples.commit.len(), 1, "commit stage sample count");
        assert_eq!(
            samples.commit_wrapper_returns, 1,
            "commit stage wrapper-return boundary count"
        );
        assert!(!probe.commit_is_pending());
        let prepare_elapsed = samples.prepare[0];
        let publish_elapsed = samples.publish[0];
        let commit_elapsed = samples.commit[0];
        drop(probe);
        assert!(!attachment_batch_performance_probe_is_active());

        let imported_attachments = &imported.workspace.attachments_by_node_id[ROOT_ID];
        assert_eq!(imported_attachments.len(), IMAGE_COUNT);
        assert_eq!(
            imported_attachments
                .iter()
                .map(|attachment| attachment.id.as_str())
                .collect::<Vec<_>>(),
            expected_ids.iter().map(String::as_str).collect::<Vec<_>>()
        );
        assert_eq!(
            imported_attachments
                .iter()
                .map(|attachment| attachment.original_name.as_str())
                .collect::<Vec<_>>(),
            expected_names
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            imported.history_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        assert!(imported.can_undo);
        assert!(!imported.can_redo);

        let expected_asset_entries = {
            let mut entries = imported_attachments
                .iter()
                .map(|attachment| {
                    std::path::Path::new(&attachment.relative_path)
                        .file_name()
                        .expect("attachment asset filename")
                        .to_string_lossy()
                        .into_owned()
                })
                .collect::<Vec<_>>();
            entries.sort();
            entries
        };
        assert_eq!(expected_asset_entries.len(), IMAGE_COUNT);
        assert_eq!(asset_directory_entries(&vault_path), expected_asset_entries);

        let shared = acquire_notes_connection(&vault_path).expect("inspect imported batch");
        let connection = lock_notes_connection(&shared).expect("lock imported batch history");
        let metadata_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("count imported metadata rows");
        let history_entries: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_history_entries", [], |row| {
                row.get(0)
            })
            .expect("count committed history entries");
        assert_eq!(metadata_rows, IMAGE_COUNT as i64);
        assert_eq!(history_entries, 1);
        drop(connection);
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("inspect import marker");
        assert!(!storage
            .reconciliation_needed()
            .expect("import marker state"));
        drop(storage);

        let undo_started = std::time::Instant::now();
        let undone = notes_undo(
            vault_path.clone(),
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("undo 128-image path batch");
        let undo_elapsed = undo_started.elapsed();
        assert_eq!(
            undone.replayed_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        assert!(undone
            .workspace
            .attachments_by_node_id
            .get(ROOT_ID)
            .map_or(true, Vec::is_empty));
        assert!(!undone.can_undo);
        assert!(undone.can_redo);
        let shared = acquire_notes_connection(&vault_path).expect("inspect undone batch");
        let connection = lock_notes_connection(&shared).expect("lock undone batch history");
        let metadata_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("count metadata rows after undo");
        assert_eq!(metadata_rows, 0);
        drop(connection);
        assert_eq!(asset_directory_entries(&vault_path), expected_asset_entries);
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("inspect undo marker");
        assert!(!storage.reconciliation_needed().expect("undo marker state"));
        drop(storage);

        let redo_started = std::time::Instant::now();
        let redone = notes_redo(
            vault_path.clone(),
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("redo 128-image path batch");
        let redo_elapsed = redo_started.elapsed();
        assert_eq!(
            redone.replayed_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        assert_eq!(
            redone.workspace.attachments_by_node_id[ROOT_ID]
                .iter()
                .map(|attachment| attachment.id.as_str())
                .collect::<Vec<_>>(),
            expected_ids.iter().map(String::as_str).collect::<Vec<_>>()
        );
        assert!(redone.can_undo);
        assert!(!redone.can_redo);
        let shared = acquire_notes_connection(&vault_path).expect("inspect redone batch");
        let connection = lock_notes_connection(&shared).expect("lock redone batch history");
        let (metadata_rows, history_entries): (i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM notes_attachments), \
                        (SELECT COUNT(*) FROM notes_history_entries)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("count restored metadata and history rows");
        assert_eq!((metadata_rows, history_entries), (IMAGE_COUNT as i64, 1));
        drop(connection);
        assert_eq!(asset_directory_entries(&vault_path), expected_asset_entries);
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("inspect redo marker");
        assert!(!storage.reconciliation_needed().expect("redo marker state"));

        let total_elapsed = total_started.elapsed();
        println!("notes_attachment_batch_performance prepare elapsed: {prepare_elapsed:?}");
        println!("notes_attachment_batch_performance publish elapsed: {publish_elapsed:?}");
        println!("notes_attachment_batch_performance commit elapsed: {commit_elapsed:?}");
        println!("notes_attachment_batch_performance undo elapsed: {undo_elapsed:?}");
        println!("notes_attachment_batch_performance redo elapsed: {redo_elapsed:?}");
        println!("notes_attachment_batch_performance total elapsed: {total_elapsed:?}");
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
            history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
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

    #[cfg(unix)]
    #[test]
    fn committed_attachment_reconciliation_restores_quarantine_if_database_changes() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_a = temp_dir.path().join("vault-a");
        let vault_b = temp_dir.path().join("vault-b");
        fs::create_dir(&vault_a).expect("create vault A");
        fs::create_dir(&vault_b).expect("create vault B");
        let vault_a = vault_a.to_string_lossy().into_owned();
        let vault_b = vault_b.to_string_lossy().into_owned();
        seed_attachment_batch_node(&vault_a);
        seed_attachment_batch_node(&vault_b);
        let bytes = encoded_png(4, 3);
        let source = temp_dir.path().join("shared.png");
        fs::write(&source, &bytes).expect("write shared image");
        let import = |vault_path: String| {
            notes_import_attachment(
                vault_path,
                ImportAttachmentInput {
                    id: SPLIT_ID.to_string(),
                    node_id: ROOT_ID.to_string(),
                    source_path: source.to_string_lossy().into_owned(),
                    initial_max_display_width: 480,
                },
                None,
            )
            .expect("import shared attachment")
        };
        let imported_a = import(vault_a.clone());
        let imported_b = import(vault_b.clone());
        let relative_path = imported_a.workspace.attachments_by_node_id[ROOT_ID][0]
            .relative_path
            .clone();
        assert_eq!(
            imported_b.workspace.attachments_by_node_id[ROOT_ID][0].relative_path,
            relative_path
        );

        let replacement_shared =
            acquire_notes_connection(&vault_b).expect("acquire replacement connection");
        let replacement_connection =
            lock_notes_connection(&replacement_shared).expect("lock replacement connection");
        replacement_connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .expect("checkpoint replacement database");
        drop(replacement_connection);

        let active_shared = acquire_notes_connection(&vault_a).expect("acquire active connection");
        let active_connection =
            lock_notes_connection(&active_shared).expect("lock active connection");
        let placeholder_hash = "a".repeat(64);
        active_connection
            .execute(
                "UPDATE notes_attachments SET relative_path = ?1, content_hash = ?2 WHERE id = ?3",
                params![
                    format!("notes-assets/{placeholder_hash}.png"),
                    placeholder_hash,
                    SPLIT_ID
                ],
            )
            .expect("make active attachment unreachable");
        let active_database = crate::notes::repository::notes_db_path(&vault_a);
        let replacement_database = crate::notes::repository::notes_db_path(&vault_b);
        let displaced = temp_dir.path().join("displaced-ordinary-database");
        inject_full_reconciliation_after_quarantine_once(move |_| {
            install_replacement_sqlite_database(
                &active_database,
                &replacement_database,
                &displaced,
            );
        });
        let storage = AttachmentStorageLease::acquire(&vault_a).expect("acquire storage lease");

        reconcile_after_committed_attachment_change(&storage, &active_connection);

        let asset_path = crate::metadata_dir(&vault_a).join(relative_path);
        assert_eq!(
            fs::read(asset_path).expect("replacement database asset survives"),
            bytes
        );
        assert!(
            storage.reconciliation_needed().expect("marker state"),
            "identity rejection must leave reconciliation marked"
        );
    }

    #[cfg(unix)]
    #[test]
    fn failed_attachment_batch_restores_every_asset_if_database_changes_after_first_unlink() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_a = temp_dir.path().join("vault-a");
        let vault_b = temp_dir.path().join("vault-b");
        fs::create_dir(&vault_a).expect("create vault A");
        fs::create_dir(&vault_b).expect("create vault B");
        let vault_a = vault_a.to_string_lossy().into_owned();
        let vault_b = vault_b.to_string_lossy().into_owned();
        seed_attachment_batch_node(&vault_a);
        seed_attachment_batch_node(&vault_b);
        let first = encoded_png(4, 3);
        let second = encoded_png(5, 4);
        let first_source = temp_dir.path().join("first.png");
        let second_source = temp_dir.path().join("second.png");
        fs::write(&first_source, &first).expect("write first image");
        fs::write(&second_source, &second).expect("write second image");
        let imported_b = notes_import_attachment_paths_batch(
            vault_b.clone(),
            path_batch_input(&first_source, &second_source),
            Some(batch_history_context()),
        )
        .expect("seed replacement database attachments");
        let attachments_b = &imported_b.workspace.attachments_by_node_id[ROOT_ID];
        let first_relative = attachments_b
            .iter()
            .find(|attachment| attachment.id == SPLIT_ID)
            .expect("first replacement attachment")
            .relative_path
            .clone();
        let second_relative = attachments_b
            .iter()
            .find(|attachment| attachment.id == EMPTY_ID)
            .expect("second replacement attachment")
            .relative_path
            .clone();
        let replacement_shared =
            acquire_notes_connection(&vault_b).expect("acquire replacement connection");
        let replacement_connection =
            lock_notes_connection(&replacement_shared).expect("lock replacement connection");
        replacement_connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .expect("checkpoint replacement database");
        drop(replacement_connection);

        inject_attachment_batch_fault(AttachmentBatchFault::ReturnBeforeCommit);
        let active_database = crate::notes::repository::notes_db_path(&vault_a);
        let replacement_database = crate::notes::repository::notes_db_path(&vault_b);
        let displaced = temp_dir.path().join("displaced-failed-batch-database");
        inject_full_reconciliation_after_remove_once(move |_| {
            install_replacement_sqlite_database(
                &active_database,
                &replacement_database,
                &displaced,
            );
        });

        let error = notes_import_attachment_paths_batch(
            vault_a.clone(),
            path_batch_input(&first_source, &second_source),
            Some(batch_history_context()),
        )
        .expect_err("injected failed batch");

        assert!(
            error.contains("injected attachment batch transaction failure"),
            "{error}"
        );
        for (relative_path, expected) in [
            (first_relative.as_str(), first.as_slice()),
            (second_relative.as_str(), second.as_slice()),
        ] {
            let asset_path = crate::metadata_dir(&vault_a).join(relative_path);
            assert_eq!(
                fs::read(asset_path).expect("replacement database asset survives"),
                expected
            );
        }
        let storage = AttachmentStorageLease::acquire(&vault_a).expect("inspect cleanup marker");
        assert!(
            storage.reconciliation_needed().expect("marker state"),
            "identity rejection must leave reconciliation marked"
        );
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
        let shared = acquire_notes_connection(&vault_path).expect("inspect publication failure");
        let connection = lock_notes_connection(&shared).expect("lock publication failure history");
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
    fn invalid_attachment_path_batch_does_not_create_vault_storage() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        let missing_source = temp_dir.path().join("first-missing.png");
        let metadata_path = crate::metadata_dir(&vault_path);

        let error = notes_import_attachment_paths_batch(
            vault_path,
            ImportAttachmentPathBatchInput {
                node_id: ROOT_ID.to_string(),
                attachments: vec![ImportAttachmentPathItem {
                    id: SPLIT_ID.to_string(),
                    source_path: missing_source.to_string_lossy().into_owned(),
                }],
                initial_max_display_width: 480,
            },
            None,
        )
        .expect_err("invalid source must fail before storage acquisition");

        assert!(error.contains("first-missing.png"), "{error}");
        assert!(
            !metadata_path.exists(),
            "invalid input mutated Vault storage"
        );
    }

    #[test]
    fn invalid_image_node_path_batch_does_not_create_vault_storage() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        let first_missing = temp_dir.path().join("first-missing.png");
        let second_missing = temp_dir.path().join("second-missing.png");
        let metadata_path = crate::metadata_dir(&vault_path);

        let error = notes_import_image_node_paths_batch(
            vault_path,
            image_node_path_input(None, None, &first_missing, &second_missing),
            Some(image_node_history_context()),
        )
        .expect_err("invalid image source must fail before storage acquisition");

        assert!(error.contains("first-missing.png"), "{error}");
        assert!(!error.contains("second-missing.png"), "{error}");
        assert!(
            !metadata_path.exists(),
            "invalid image input mutated Vault storage"
        );
    }

    #[test]
    fn notes_attachment_path_batch_reports_only_the_first_invalid_source_before_publish() {
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
        assert!(!error.contains("missing.png"), "{error}");
        assert!(
            !error.contains(temp_dir.path().to_string_lossy().as_ref()),
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
    fn same_process_lock_reentrancy_rejects_a_replaced_metadata_identity() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_initialize(vault_path.clone()).expect("initialize locked vault");
        let metadata = crate::metadata_dir(&vault_path);
        let relocated = temp_dir.path().join(".yonalist-relocated");
        fs::rename(&metadata, &relocated).expect("relocate held metadata directory");
        fs::create_dir(&metadata).expect("create replacement metadata directory");

        let error = notes_create_node(
            vault_path,
            CreateNodeInput {
                id: ROOT_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "Must not reach replacement storage".to_string(),
                note: String::new(),
            },
            None,
        )
        .expect_err("reentrant access must remain bound to the locked metadata identity");

        assert!(
            error.contains("application lock identity changed"),
            "{error}"
        );
        assert!(!metadata.join("notes.sqlite").exists());
        assert!(relocated.join("notes.sqlite").exists());
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
    fn rejected_second_process_cannot_read_mutate_import_export_or_delete_the_vault() {
        const CHILD_ENV: &str = "YONALIST_NOTES_APP_LOCK_OWNER_CHILD";
        const TEST_NAME: &str = "notes::commands::tests::rejected_second_process_cannot_read_mutate_import_export_or_delete_the_vault";

        let child_vault = std::env::var_os(CHILD_ENV);
        if let Some(vault_path) = child_vault {
            let vault_path = PathBuf::from(vault_path).to_string_lossy().into_owned();
            initialize_empty_test_vault(&vault_path);
            notes_create_node(
                vault_path.clone(),
                CreateNodeInput {
                    id: ROOT_ID.to_string(),
                    parent_id: None,
                    after_id: None,
                    title: "Owned by child".to_string(),
                    note: String::new(),
                },
                None,
            )
            .expect("child seeds root node");
            fs::write(Path::new(&vault_path).join("lock-owner-ready"), b"ready")
                .expect("signal child readiness");
            let stop = Path::new(&vault_path).join("lock-owner-stop");
            for _ in 0..1_000 {
                if stop.exists() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            panic!("parent did not release child lock owner");
        }

        struct ChildGuard(std::process::Child);

        impl Drop for ChildGuard {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        let mut child = ChildGuard(
            std::process::Command::new(std::env::current_exe().expect("current test exe"))
                .arg(TEST_NAME)
                .arg("--exact")
                .arg("--nocapture")
                .env(CHILD_ENV, &vault_path)
                .spawn()
                .expect("start lock-owning child process"),
        );
        let ready = temp_dir.path().join("lock-owner-ready");
        for _ in 0..1_000 {
            if ready.exists() {
                break;
            }
            assert!(
                child.0.try_wait().expect("inspect child status").is_none(),
                "lock-owning child exited before readiness"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(ready.exists(), "lock-owning child did not become ready");

        let assert_lock_busy = |error: String| {
            assert_eq!(error, "Notes vault is already open in another window.");
        };
        assert_lock_busy(
            notes_initialize(vault_path.clone()).expect_err("second initialize is rejected"),
        );
        assert_lock_busy(
            notes_load_workspace(vault_path.clone(), NotesWorkspaceScope::Active)
                .expect_err("second process read is rejected"),
        );
        assert_lock_busy(
            notes_create_node(
                vault_path.clone(),
                CreateNodeInput {
                    id: SPLIT_ID.to_string(),
                    parent_id: None,
                    after_id: None,
                    title: "Second process mutation".to_string(),
                    note: String::new(),
                },
                None,
            )
            .expect_err("second process mutation is rejected"),
        );

        let import_source = temp_dir.path().join("second-process.png");
        fs::write(&import_source, encoded_png(2, 2)).expect("write import source");
        assert_lock_busy(
            notes_import_attachment(
                vault_path.clone(),
                ImportAttachmentInput {
                    id: EMPTY_ID.to_string(),
                    node_id: ROOT_ID.to_string(),
                    source_path: import_source.to_string_lossy().into_owned(),
                    initial_max_display_width: 480,
                },
                None,
            )
            .expect_err("second process import is rejected"),
        );

        let export_destination = temp_dir.path().join("second-process.md");
        assert_lock_busy(
            notes_export_markdown(
                vault_path.clone(),
                ROOT_ID.to_string(),
                export_destination.to_string_lossy().into_owned(),
                true,
            )
            .expect_err("second process export is rejected"),
        );
        assert_lock_busy(
            notes_delete_database(vault_path.clone())
                .expect_err("second process deletion is rejected"),
        );

        assert!(crate::notes::repository::notes_db_path(&vault_path).exists());
        assert!(!export_destination.exists());
        fs::write(temp_dir.path().join("lock-owner-stop"), b"stop")
            .expect("release child lock owner");
        let status = child.0.wait().expect("wait for lock-owning child");
        assert!(status.success(), "lock-owning child failed: {status}");
        std::mem::forget(child);

        let workspace = notes_load_workspace(vault_path, NotesWorkspaceScope::Active)
            .expect("vault remains readable after lock owner exits");
        assert_eq!(workspace.nodes.len(), 1);
        assert_eq!(workspace.nodes[0].id, ROOT_ID);
        assert!(workspace.attachments_by_node_id.is_empty());
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
        let shared = acquire_notes_connection(&vault_path).expect("retry database");
        let connection = lock_notes_connection(&shared).expect("lock retry history database");
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
        let files_after_commit = asset_directory_entries(&vault_path);
        let mut stale_history = history_context.clone();
        stale_history.history_epoch = "stale-epoch".to_string();
        let stale_error = notes_import_attachment_paths_batch(
            vault_path.clone(),
            input.clone(),
            Some(stale_history),
        )
        .expect_err("committed attachment retry with stale epoch");
        assert!(
            stale_error.to_lowercase().contains("epoch"),
            "{stale_error}"
        );
        assert_eq!(history_entry_count(&vault_path), 1);
        assert_eq!(asset_directory_entries(&vault_path), files_after_commit);

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
            node_kind: NoteNodeKind::Text,
            title: "Page".to_string(),
            image_offset_utf16: 0,
            attachment_name: None,
            display_label: "Page".to_string(),
            parent_trail: vec!["Home".to_string()],
            parent_trail_kinds: vec![NoteNodeKind::Image],
            matched_field: NoteSearchMatchedField::Title,
        };
        assert_eq!(
            serde_json::to_value(search_result).expect("search result JSON"),
            json!({
                "nodeId": ROOT_ID,
                "nodeKind": "text",
                "title": "Page",
                "imageOffsetUtf16": 0,
                "attachmentName": null,
                "displayLabel": "Page",
                "parentTrail": ["Home"],
                "parentTrailKinds": ["image"],
                "matchedField": "title"
            })
        );

        let workspace = NotesWorkspace {
            nodes: vec![NoteNode {
                id: ROOT_ID.to_string(),
                node_kind: NoteNodeKind::Text,
                parent_id: None,
                sort_key: 1024,
                title: "Page".to_string(),
                note: "Supporting note".to_string(),
                image_offset_utf16: 0,
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
                    "nodeKind": "text",
                    "parentId": null,
                    "sortKey": 1024,
                    "title": "Page",
                    "note": "Supporting note",
                    "imageOffsetUtf16": 0,
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

        initialize_empty_test_vault(&vault_path);
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
                image_offset_utf16: 0,
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

        initialize_empty_test_vault(&vault_path);
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
                history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
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
                history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
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
                history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
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
    fn batch_duplicate_returns_ordered_roots_and_replays_one_atomic_history_entry() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        initialize_empty_test_vault(&vault_path);
        seed_batch_node(&vault_path, BATCH_D_ID, None, None);
        seed_batch_node(&vault_path, BATCH_A_ID, Some(BATCH_D_ID), None);
        seed_batch_node(&vault_path, BATCH_C_ID, Some(BATCH_A_ID), None);
        seed_batch_node(&vault_path, BATCH_B_ID, Some(BATCH_D_ID), Some(BATCH_A_ID));
        seed_batch_node(
            &vault_path,
            BATCH_MISSING_ID,
            Some(BATCH_D_ID),
            Some(BATCH_B_ID),
        );

        let mutation = notes_apply_batch(
            vault_path.clone(),
            ApplyBatchInput {
                node_ids: vec![
                    BATCH_B_ID.to_string(),
                    BATCH_C_ID.to_string(),
                    BATCH_A_ID.to_string(),
                ],
                op: BatchOp::Duplicate,
            },
            Some(batch_op_context(REPLACEMENT_ENTRY_ID, "batchDuplicate")),
        )
        .expect("batch duplicate");

        assert_eq!(
            mutation.history_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        assert_eq!(history_entry_count(&vault_path), 1);
        let children = active_child_ids(&vault_path, Some(BATCH_D_ID));
        assert_eq!(children.len(), 5);
        let copied_root_ids = vec![children[2].clone(), children[3].clone()];
        assert_eq!(
            children,
            vec![
                BATCH_A_ID.to_string(),
                BATCH_B_ID.to_string(),
                copied_root_ids[0].clone(),
                copied_root_ids[1].clone(),
                BATCH_MISSING_ID.to_string(),
            ]
        );
        assert_eq!(
            mutation.duplicated_root_ids.as_ref(),
            Some(&copied_root_ids),
            "the result reports only copied roots in stored source order"
        );
        let copied_a_children = active_child_ids(&vault_path, Some(&copied_root_ids[0]));
        assert_eq!(copied_a_children.len(), 1);
        let copied_node_ids = [
            copied_root_ids[0].clone(),
            copied_a_children[0].clone(),
            copied_root_ids[1].clone(),
        ]
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
        let mut copied_snapshot = mutation
            .workspace
            .nodes
            .iter()
            .filter(|node| copied_node_ids.contains(&node.id))
            .map(|node| {
                (
                    node.id.clone(),
                    node.parent_id.clone(),
                    node.sort_key,
                    node.title.clone(),
                    node.note.clone(),
                )
            })
            .collect::<Vec<_>>();
        copied_snapshot.sort();
        assert_eq!(copied_snapshot.len(), 3);

        let undone = notes_undo(
            vault_path.clone(),
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("undo batch duplicate");
        assert_eq!(
            undone.replayed_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        assert_eq!(
            active_child_ids(&vault_path, Some(BATCH_D_ID)),
            vec![
                BATCH_A_ID.to_string(),
                BATCH_B_ID.to_string(),
                BATCH_MISSING_ID.to_string(),
            ]
        );
        assert!(undone
            .workspace
            .nodes
            .iter()
            .all(|node| !copied_node_ids.contains(&node.id)));

        let redone = notes_redo(
            vault_path.clone(),
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("redo batch duplicate");
        assert_eq!(
            active_child_ids(&vault_path, Some(BATCH_D_ID)),
            vec![
                BATCH_A_ID.to_string(),
                BATCH_B_ID.to_string(),
                copied_root_ids[0].clone(),
                copied_root_ids[1].clone(),
                BATCH_MISSING_ID.to_string(),
            ]
        );
        let mut restored_snapshot = redone
            .workspace
            .nodes
            .iter()
            .filter(|node| copied_node_ids.contains(&node.id))
            .map(|node| {
                (
                    node.id.clone(),
                    node.parent_id.clone(),
                    node.sort_key,
                    node.title.clone(),
                    node.note.clone(),
                )
            })
            .collect::<Vec<_>>();
        restored_snapshot.sort();
        assert_eq!(restored_snapshot, copied_snapshot);
        assert_eq!(history_entry_count(&vault_path), 1);
    }

    #[test]
    fn batch_duplicate_later_root_failure_leaves_no_copies_or_history() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        initialize_empty_test_vault(&vault_path);
        notes_create_node(
            vault_path.clone(),
            CreateNodeInput {
                id: BATCH_A_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "A #Safe".to_string(),
                note: String::new(),
            },
            None,
        )
        .expect("first source");
        notes_create_node(
            vault_path.clone(),
            CreateNodeInput {
                id: BATCH_B_ID.to_string(),
                parent_id: None,
                after_id: Some(BATCH_A_ID.to_string()),
                title: "B #Reject".to_string(),
                note: String::new(),
            },
            None,
        )
        .expect("second source");
        let connection = connect_notes_db(&vault_path).expect("open failure fixture");
        connection
            .execute_batch(
                "CREATE TRIGGER reject_command_duplicate_tag BEFORE INSERT ON notes_tags \
                 WHEN NEW.normalized_tag = 'reject' \
                 BEGIN SELECT RAISE(ABORT, 'command duplicate index rejected'); END;",
            )
            .expect("later-root index failure trigger");
        drop(connection);
        let before = active_child_ids(&vault_path, None);

        let error = notes_apply_batch(
            vault_path.clone(),
            ApplyBatchInput {
                node_ids: vec![BATCH_A_ID.to_string(), BATCH_B_ID.to_string()],
                op: BatchOp::Duplicate,
            },
            Some(batch_op_context(REPLACEMENT_ENTRY_ID, "batchDuplicate")),
        )
        .expect_err("later-root failure");

        assert!(
            error.contains("command duplicate index rejected"),
            "unexpected error: {error}"
        );
        assert_eq!(active_child_ids(&vault_path, None), before);
        assert_eq!(history_entry_count(&vault_path), 0);
    }

    #[test]
    fn batch_tag_remove_is_one_dated_undoable_entry_and_all_noops_skip_history() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        initialize_empty_test_vault(&vault_path);
        for (id, parent_id, after_id, title, note) in [
            (BATCH_A_ID, None, None, "A #Roadmap today", "note #ROADMAP"),
            (
                BATCH_B_ID,
                None,
                Some(BATCH_A_ID),
                "B",
                "#roadmap supporting",
            ),
            (
                BATCH_C_ID,
                Some(BATCH_A_ID),
                None,
                "C #Roadmap",
                "unchanged",
            ),
        ] {
            notes_create_node(
                vault_path.clone(),
                CreateNodeInput {
                    id: id.to_string(),
                    parent_id: parent_id.map(str::to_string),
                    after_id: after_id.map(str::to_string),
                    title: title.to_string(),
                    note: note.to_string(),
                },
                None,
            )
            .expect("seed batch tag node");
        }
        let input = ApplyBatchInput {
            node_ids: vec![
                BATCH_A_ID.to_string(),
                BATCH_B_ID.to_string(),
                BATCH_A_ID.to_string(),
            ],
            op: BatchOp::RemoveTag {
                tag: NoteTagFilter {
                    prefix: NoteTagPrefix::Hash,
                    normalized_tag: "roadmap".to_string(),
                },
            },
        };

        let mutation = notes_apply_batch(
            vault_path.clone(),
            input.clone(),
            Some(batch_op_context(REPLACEMENT_ENTRY_ID, "batchRemoveTag")),
        )
        .expect("batch remove tag");

        assert_eq!(
            mutation.history_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        assert!(mutation.can_undo);
        assert!(!mutation.can_redo);
        assert_eq!(history_entry_count(&vault_path), 1);
        let changed_ids = mutation
            .changed_nodes
            .as_ref()
            .expect("batch tag delta")
            .iter()
            .map(|node| node.id.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            changed_ids,
            std::collections::BTreeSet::from([BATCH_A_ID, BATCH_B_ID])
        );
        for (id, expected_title, expected_note) in [
            (BATCH_A_ID, "A today", "note"),
            (BATCH_B_ID, "B", "supporting"),
            (BATCH_C_ID, "C #Roadmap", "unchanged"),
        ] {
            let node = mutation
                .workspace
                .nodes
                .iter()
                .find(|node| node.id == id)
                .expect("batch tag result node");
            assert_eq!(
                (node.title.as_str(), node.note.as_str()),
                (expected_title, expected_note)
            );
        }
        let connection = connect_notes_db(&vault_path).expect("open dated batch tag vault");
        let expected_today: String = connection
            .query_row("SELECT date('now', 'localtime')", [], |row| row.get(0))
            .expect("system local date");
        let indexed_date: (i64, String) = connection
            .query_row(
                "SELECT start_utf16, normalized_start FROM notes_dates \
                 WHERE node_id = ?1 AND field = 'title'",
                [BATCH_A_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("dated batch tag index");
        assert_eq!(indexed_date, (2, expected_today));
        drop(connection);

        let undone = notes_undo(
            vault_path.clone(),
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("undo batch tag removal");
        assert_eq!(
            undone.replayed_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        let undone_a = undone
            .workspace
            .nodes
            .iter()
            .find(|node| node.id == BATCH_A_ID)
            .expect("undone first node");
        let undone_b = undone
            .workspace
            .nodes
            .iter()
            .find(|node| node.id == BATCH_B_ID)
            .expect("undone second node");
        assert_eq!(
            (undone_a.title.as_str(), undone_a.note.as_str()),
            ("A #Roadmap today", "note #ROADMAP")
        );
        assert_eq!(
            (undone_b.title.as_str(), undone_b.note.as_str()),
            ("B", "#roadmap supporting")
        );

        let redone = notes_redo(
            vault_path.clone(),
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("redo batch tag removal");
        assert_eq!(
            redone.replayed_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        let redone_a = redone
            .workspace
            .nodes
            .iter()
            .find(|node| node.id == BATCH_A_ID)
            .expect("redone first node");
        let redone_b = redone
            .workspace
            .nodes
            .iter()
            .find(|node| node.id == BATCH_B_ID)
            .expect("redone second node");
        assert_eq!(
            (redone_a.title.as_str(), redone_a.note.as_str()),
            ("A today", "note")
        );
        assert_eq!(
            (redone_b.title.as_str(), redone_b.note.as_str()),
            ("B", "supporting")
        );

        let noop = notes_apply_batch(
            vault_path.clone(),
            input,
            Some(batch_op_context(NOOP_ENTRY_ID, "batchRemoveTag")),
        )
        .expect("all-noop batch tag removal");
        assert_eq!(noop.history_entry_id, None);
        assert!(noop.can_undo);
        assert!(!noop.can_redo);
        assert_eq!(history_entry_count(&vault_path), 1);
    }

    #[test]
    fn batch_complete_sets_every_node_in_one_history_entry_and_undo_reverts_all() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        initialize_empty_test_vault(&vault_path);
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
        assert_eq!(mutation.duplicated_root_ids, None);
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
        initialize_empty_test_vault(&vault_path);
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
        initialize_empty_test_vault(&vault_path);
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
        assert_eq!(active, vec![BATCH_A_ID.to_string(), BATCH_C_ID.to_string()]);
        assert!(deleted_batch_id_of(&vault_path, BATCH_B_ID).is_some());
        assert!(deleted_batch_id_of(&vault_path, BATCH_D_ID).is_some());
    }

    #[test]
    fn batch_move_places_the_selection_as_a_contiguous_ordered_block() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        initialize_empty_test_vault(&vault_path);
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
                    before_id: None,
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
    fn batch_move_before_first_is_one_atomic_undoable_reorder() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        initialize_empty_test_vault(&vault_path);
        seed_batch_node(&vault_path, BATCH_A_ID, None, None);
        seed_batch_node(&vault_path, BATCH_B_ID, None, Some(BATCH_A_ID));
        seed_batch_node(&vault_path, BATCH_C_ID, None, Some(BATCH_B_ID));
        seed_batch_node(&vault_path, BATCH_D_ID, None, Some(BATCH_C_ID));

        let mutation = notes_apply_batch(
            vault_path.clone(),
            ApplyBatchInput {
                node_ids: vec![BATCH_B_ID.to_string(), BATCH_C_ID.to_string()],
                op: BatchOp::Move {
                    parent_id: None,
                    after_id: None,
                    before_id: Some(BATCH_A_ID.to_string()),
                },
            },
            Some(batch_op_context(REPLACEMENT_ENTRY_ID, "batchMove")),
        )
        .expect("move selected block before the first sibling");

        assert_eq!(
            mutation.history_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        assert_eq!(history_entry_count(&vault_path), 1);
        assert_eq!(
            active_child_ids(&vault_path, None),
            vec![
                BATCH_B_ID.to_string(),
                BATCH_C_ID.to_string(),
                BATCH_A_ID.to_string(),
                BATCH_D_ID.to_string(),
            ]
        );

        let undone = notes_undo(
            vault_path.clone(),
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("undo before-anchored batch move");
        assert_eq!(
            undone.replayed_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        assert_eq!(
            active_child_ids(&vault_path, None),
            vec![
                BATCH_A_ID.to_string(),
                BATCH_B_ID.to_string(),
                BATCH_C_ID.to_string(),
                BATCH_D_ID.to_string(),
            ]
        );

        let redone = notes_redo(
            vault_path.clone(),
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("redo before-anchored batch move");
        assert_eq!(
            redone.replayed_entry_id.as_deref(),
            Some(REPLACEMENT_ENTRY_ID)
        );
        assert_eq!(
            active_child_ids(&vault_path, None),
            vec![
                BATCH_B_ID.to_string(),
                BATCH_C_ID.to_string(),
                BATCH_A_ID.to_string(),
                BATCH_D_ID.to_string(),
            ]
        );
    }

    #[test]
    fn batch_move_before_existing_position_is_a_true_noop() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        initialize_empty_test_vault(&vault_path);
        seed_batch_node(&vault_path, BATCH_A_ID, None, None);
        seed_batch_node(&vault_path, BATCH_B_ID, None, Some(BATCH_A_ID));
        seed_batch_node(&vault_path, BATCH_C_ID, None, Some(BATCH_B_ID));
        seed_batch_node(&vault_path, BATCH_D_ID, None, Some(BATCH_C_ID));

        let mutation = notes_apply_batch(
            vault_path.clone(),
            ApplyBatchInput {
                node_ids: vec![BATCH_B_ID.to_string(), BATCH_C_ID.to_string()],
                op: BatchOp::Move {
                    parent_id: None,
                    after_id: None,
                    before_id: Some(BATCH_D_ID.to_string()),
                },
            },
            Some(batch_op_context(NOOP_ENTRY_ID, "batchMove")),
        )
        .expect("already-positioned block is a no-op");

        assert_eq!(mutation.history_entry_id, None);
        assert!(!mutation.can_undo);
        assert_eq!(history_entry_count(&vault_path), 0);
        assert_eq!(
            active_child_ids(&vault_path, None),
            vec![
                BATCH_A_ID.to_string(),
                BATCH_B_ID.to_string(),
                BATCH_C_ID.to_string(),
                BATCH_D_ID.to_string(),
            ]
        );
    }

    #[test]
    fn batch_move_before_rejects_selected_descendant_cross_parent_and_missing_anchors_atomically() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        initialize_empty_test_vault(&vault_path);
        seed_batch_node(&vault_path, BATCH_A_ID, None, None);
        seed_batch_node(&vault_path, BATCH_B_ID, Some(BATCH_A_ID), None);
        seed_batch_node(&vault_path, BATCH_D_ID, None, Some(BATCH_A_ID));
        seed_batch_node(&vault_path, BATCH_C_ID, Some(BATCH_D_ID), None);

        let cases = [
            (vec![BATCH_A_ID.to_string()], None, BATCH_A_ID, "selection"),
            (
                vec![BATCH_A_ID.to_string()],
                Some(BATCH_D_ID.to_string()),
                BATCH_B_ID,
                "descendant",
            ),
            (
                vec![BATCH_B_ID.to_string()],
                Some(BATCH_D_ID.to_string()),
                BATCH_A_ID,
                "sibling",
            ),
            (
                vec![BATCH_B_ID.to_string()],
                Some(BATCH_D_ID.to_string()),
                BATCH_MISSING_ID,
                "sibling",
            ),
        ];

        for (node_ids, parent_id, before_id, expected_error) in cases {
            let error = notes_apply_batch(
                vault_path.clone(),
                ApplyBatchInput {
                    node_ids,
                    op: BatchOp::Move {
                        parent_id,
                        after_id: None,
                        before_id: Some(before_id.to_string()),
                    },
                },
                Some(batch_op_context(REPLACEMENT_ENTRY_ID, "batchMove")),
            )
            .expect_err("invalid before anchor must reject the whole batch");
            assert!(
                error.to_lowercase().contains(expected_error),
                "unexpected error for {before_id}: {error}"
            );
            assert_eq!(history_entry_count(&vault_path), 0);
            assert_eq!(
                active_child_ids(&vault_path, None),
                vec![BATCH_A_ID.to_string(), BATCH_D_ID.to_string()]
            );
            assert_eq!(
                active_child_ids(&vault_path, Some(BATCH_A_ID)),
                vec![BATCH_B_ID.to_string()]
            );
            assert_eq!(
                active_child_ids(&vault_path, Some(BATCH_D_ID)),
                vec![BATCH_C_ID.to_string()]
            );
        }
    }

    #[test]
    fn batch_move_under_a_live_descendant_rejects_the_whole_batch() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        initialize_empty_test_vault(&vault_path);
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
                    before_id: None,
                },
            },
            Some(batch_op_context(REPLACEMENT_ENTRY_ID, "batchMove")),
        )
        .expect_err("descendant move must be rejected");
        assert_eq!(
            error,
            "A Note node cannot be moved under a live descendant."
        );

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
        seed_batch_node(
            &vault_path,
            BATCH_MISSING_ID,
            Some(BATCH_D_ID),
            Some(BATCH_C_ID),
        );

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
        assert_eq!(noop.duplicated_root_ids, None);
        assert_eq!(history_entry_count(&vault_path), 0);
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
        initialize_empty_test_vault(&vault_path);
        // Grandparent A > parent B > children C, (missing-id).
        seed_batch_node(&vault_path, BATCH_A_ID, None, None);
        seed_batch_node(&vault_path, BATCH_B_ID, Some(BATCH_A_ID), None);
        seed_batch_node(&vault_path, BATCH_C_ID, Some(BATCH_B_ID), None);
        seed_batch_node(
            &vault_path,
            BATCH_MISSING_ID,
            Some(BATCH_B_ID),
            Some(BATCH_C_ID),
        );

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
            workspace
                .nodes
                .iter()
                .all(|node| node.completed_at.is_none()),
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
                history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
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
                params![IMAGE_ATTACHMENT_A_ID, SPLIT_ID, "a".repeat(64)],
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
                history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
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
                history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
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
                history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
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
                history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
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
                history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
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
                history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
                entry_id: REPLACEMENT_ENTRY_ID.to_string(),
                command_kind: "collapseAll".to_string(),
            }),
        )
        .expect_err("cyclic collapse");

        assert_eq!(
            error,
            "The Notes tree contains a cycle and cannot be expanded or collapsed."
        );
        let status = notes_history_status(vault_path.clone(), SESSION_ID.to_string())
            .expect("cycle history status");
        assert!(!status.can_undo);
        assert!(!status.can_redo);
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
                    history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
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
            let status = notes_history_status(vault_path, SESSION_ID.to_string())
                .expect("history status after rejected import");
            assert!(!status.can_undo, "{label}");
            assert!(!status.can_redo, "{label}");
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
                history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
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
                history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
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
        let shared = acquire_notes_connection(&vault_path).expect("reopen capacity vault");
        let connection = lock_notes_connection(&shared).expect("lock capacity history vault");
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
        initialize_empty_test_vault(&vault_path);
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

        let search_results = notes_search(
            vault_path.clone(),
            "target".to_string(),
            NoteSearchScope::Active,
        )
        .expect("search");
        let search_result = search_results.first().expect("search result");
        assert_eq!(search_result.node_id, ROOT_ID);
        assert_eq!(search_result.node_kind, NoteNodeKind::Text);
        assert!(search_result.parent_trail_kinds.is_empty());

        let structured_results = notes_search_structured(
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
        .expect("structured search");
        let structured_result = structured_results
            .first()
            .expect("structured search result");
        assert_eq!(structured_result.node_id, ROOT_ID);
        assert_eq!(structured_result.node_kind, NoteNodeKind::Text);
        assert!(structured_result.parent_trail_kinds.is_empty());
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
    fn notes_delete_database_blocks_a_connection_racing_into_the_unlink_window() {
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

        // Arm the hook so a read-only acquisition attempts to enter after the
        // deletion gate is held but before file removal.
        arm_delete_database_race();
        let deletion = notes_delete_database(vault_path.clone()).expect("delete database");
        assert!(!deletion.attachment_cleanup_failed);
        assert!(
            !crate::notes::repository::notes_db_path(&vault_path).exists(),
            "deletion must unlink the database file"
        );

        assert!(
            take_delete_database_raced_connection().is_none(),
            "the deletion gate must reject a raced connection acquisition"
        );

        // Once the gate drops, a fresh connection must target a real on-disk
        // database, so a write persists and is readable through a later command.
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
    fn notes_delete_database_waits_for_an_in_flight_connection_user() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        notes_create_node(
            vault_path.clone(),
            CreateNodeInput {
                id: ROOT_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "Held open".to_string(),
                note: String::new(),
            },
            None,
        )
        .expect("create node before deletion");
        let shared = acquire_notes_connection(&vault_path).expect("acquire held connection");
        let connection = lock_notes_connection(&shared).expect("lock held connection");
        let (started_sender, started_receiver) = std::sync::mpsc::channel();
        let (result_sender, result_receiver) = std::sync::mpsc::channel();

        std::thread::scope(|scope| {
            let deletion_vault_path = vault_path.clone();
            scope.spawn(move || {
                started_sender.send(()).expect("announce deletion");
                result_sender
                    .send(notes_delete_database(deletion_vault_path))
                    .expect("send deletion result");
            });
            started_receiver.recv().expect("deletion started");
            assert!(
                matches!(
                    result_receiver.recv_timeout(std::time::Duration::from_millis(500)),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                ),
                "database deletion must wait for an active connection guard"
            );
            assert!(
                crate::notes::repository::notes_db_path(&vault_path).exists(),
                "the database must remain installed while a connection user is active"
            );

            drop(connection);
            let deletion = result_receiver
                .recv_timeout(std::time::Duration::from_secs(5))
                .expect("deletion completed after active user drained")
                .expect("delete database");
            assert!(!deletion.attachment_cleanup_failed);
        });
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
        initialize_empty_test_vault(&vault_path);
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
    fn pdf_export_overwrite_rejects_the_live_notes_database_destination() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        let database = crate::notes::repository::notes_db_path(&vault_path_string);
        let original = fs::read(&database).expect("snapshot live Notes database");

        let error = notes_export_pdf(
            vault_path_string,
            ROOT_ID.to_string(),
            database.to_string_lossy().into_owned(),
            true,
        )
        .expect_err("live Notes database must not be an export destination");

        assert!(error.contains("vault metadata"), "{error}");
        assert_eq!(
            fs::read(database).expect("read preserved Notes database"),
            original
        );
    }

    #[test]
    fn pdf_export_overwrite_rejects_an_exact_owned_notes_asset_destination() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        let owned_asset = import_export_attachment(
            &temp_dir,
            &vault_path_string,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "protected.png",
        );
        let original = fs::read(&owned_asset).expect("snapshot owned Notes asset");

        let error = notes_export_pdf(
            vault_path_string,
            ROOT_ID.to_string(),
            owned_asset.to_string_lossy().into_owned(),
            true,
        )
        .expect_err("owned Notes asset must not be an export destination");

        assert!(error.contains("vault metadata"), "{error}");
        assert_eq!(
            fs::read(owned_asset).expect("read preserved Notes asset"),
            original
        );
    }

    #[test]
    fn markdown_export_rejects_document_and_derived_assets_inside_vault_metadata() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        import_export_attachment(
            &temp_dir,
            &vault_path_string,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "protected-markdown.png",
        );
        let metadata = crate::metadata_dir(&vault_path_string);
        let destination = metadata.join("protected.md");
        let derived_assets = metadata.join("protected_assets");

        let error = notes_export_markdown(
            vault_path_string,
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            true,
        )
        .expect_err("metadata-local Markdown outputs must be rejected");

        assert!(error.contains("vault metadata"), "{error}");
        assert!(!destination.exists());
        assert!(!derived_assets.exists());
    }

    #[cfg(unix)]
    #[test]
    fn pdf_export_revalidates_a_relocated_parent_immediately_before_publication() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        let metadata = crate::metadata_dir(&vault_path_string);
        let database = crate::notes::repository::notes_db_path(&vault_path_string);
        let original_database = fs::read(&database).expect("snapshot Notes database");
        let export_parent = temp_dir.path().join("outside");
        let relocated_parent = temp_dir.path().join("outside-relocated");
        fs::create_dir(&export_parent).expect("create export parent");
        let destination = export_parent.join("relocated.pdf");
        let raced_parent = export_parent.clone();
        let raced_relocated = relocated_parent.clone();
        let raced_metadata = metadata.clone();
        inject_export_before_publication_once(move || {
            fs::rename(&raced_parent, &raced_relocated).expect("relocate export parent");
            symlink(&raced_metadata, &raced_parent).expect("redirect export parent to metadata");
        });

        let error = notes_export_pdf(
            vault_path_string,
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            true,
        )
        .expect_err("relocated export parent must fail closed");

        assert!(error.contains("identity changed"), "{error}");
        assert!(!metadata.join("relocated.pdf").exists());
        assert_eq!(
            fs::read(database).expect("preserved database"),
            original_database
        );
    }

    #[cfg(unix)]
    #[test]
    fn pdf_export_rolls_back_through_the_held_parent_after_final_revalidation_relocation() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        let metadata = crate::metadata_dir(&vault_path_string);
        let database = crate::notes::repository::notes_db_path(&vault_path_string);
        let original_database = fs::read(&database).expect("snapshot Notes database");
        let export_parent = temp_dir.path().join("post-validation-pdf");
        let relocated_parent = temp_dir.path().join("post-validation-pdf-held");
        fs::create_dir(&export_parent).expect("create export parent");
        let destination = export_parent.join("relocated.pdf");
        fs::write(&destination, b"original PDF destination").expect("seed destination");
        let raced_parent = export_parent.clone();
        let raced_relocated = relocated_parent.clone();
        let raced_metadata = metadata.clone();
        inject_export_after_final_revalidation_once(move || {
            fs::rename(&raced_parent, &raced_relocated).expect("relocate validated export parent");
            symlink(&raced_metadata, &raced_parent).expect("redirect export parent to metadata");
        });

        let error = notes_export_pdf(
            vault_path_string,
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            true,
        )
        .expect_err("post-validation relocation must be detected and rolled back");

        assert!(error.contains("identity changed"), "{error}");
        assert!(!metadata.join("relocated.pdf").exists());
        assert_eq!(
            fs::read(relocated_parent.join("relocated.pdf")).expect("read rolled-back destination"),
            b"original PDF destination"
        );
        assert_eq!(
            fs::read(database).expect("preserved database"),
            original_database
        );
    }

    #[cfg(unix)]
    #[test]
    fn markdown_without_assets_rolls_back_after_final_revalidation_relocation() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        let metadata = crate::metadata_dir(&vault_path_string);
        let database = crate::notes::repository::notes_db_path(&vault_path_string);
        let original_database = fs::read(&database).expect("snapshot Notes database");
        let export_parent = temp_dir.path().join("post-validation-markdown");
        let relocated_parent = temp_dir.path().join("post-validation-markdown-held");
        fs::create_dir(&export_parent).expect("create export parent");
        let destination = export_parent.join("relocated.md");
        fs::write(&destination, b"original Markdown destination").expect("seed destination");
        let raced_parent = export_parent.clone();
        let raced_relocated = relocated_parent.clone();
        let raced_metadata = metadata.clone();
        inject_export_after_final_revalidation_once(move || {
            fs::rename(&raced_parent, &raced_relocated).expect("relocate validated export parent");
            symlink(&raced_metadata, &raced_parent).expect("redirect export parent to metadata");
        });

        let error = notes_export_markdown(
            vault_path_string,
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            true,
        )
        .expect_err("post-validation relocation must be detected and rolled back");

        assert!(error.contains("identity changed"), "{error}");
        assert!(!metadata.join("relocated.md").exists());
        assert_eq!(
            fs::read(relocated_parent.join("relocated.md")).expect("read rolled-back destination"),
            b"original Markdown destination"
        );
        assert_eq!(
            fs::read(database).expect("preserved database"),
            original_database
        );
    }

    #[cfg(unix)]
    #[test]
    fn markdown_with_assets_never_publishes_through_a_post_validation_parent_symlink() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        import_export_attachment(
            &temp_dir,
            &vault_path_string,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "post-validation-asset.png",
        );
        let metadata = crate::metadata_dir(&vault_path_string);
        let database = crate::notes::repository::notes_db_path(&vault_path_string);
        let original_database = fs::read(&database).expect("snapshot Notes database");
        let source_assets = metadata.join("notes-assets");
        let original_source_assets = fs::read_dir(&source_assets)
            .expect("snapshot source assets")
            .map(|entry| entry.expect("source asset entry").file_name())
            .collect::<Vec<_>>();
        let export_parent = temp_dir.path().join("post-validation-assets");
        let relocated_parent = temp_dir.path().join("post-validation-assets-held");
        fs::create_dir(&export_parent).expect("create export parent");
        let destination = export_parent.join("relocated.md");
        let raced_parent = export_parent.clone();
        let raced_relocated = relocated_parent.clone();
        let raced_metadata = metadata.clone();
        inject_export_after_final_revalidation_once(move || {
            fs::rename(&raced_parent, &raced_relocated).expect("relocate validated export parent");
            symlink(&raced_metadata, &raced_parent).expect("redirect export parent to metadata");
        });

        let error = notes_export_markdown(
            vault_path_string,
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            false,
        )
        .expect_err("post-validation relocation must be detected and rolled back");

        assert!(error.contains("identity changed"), "{error}");
        assert!(!metadata.join("relocated.md").exists());
        assert!(!metadata.join("relocated_assets").exists());
        assert_eq!(
            fs::read(database).expect("preserved database"),
            original_database
        );
        assert_eq!(
            fs::read_dir(source_assets)
                .expect("inspect preserved source assets")
                .map(|entry| entry.expect("source asset entry").file_name())
                .collect::<Vec<_>>(),
            original_source_assets
        );
    }

    #[cfg(unix)]
    #[test]
    fn markdown_export_revalidates_a_relocated_parent_before_asset_publication() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        seed_export_vault(&vault_path_string);
        import_export_attachment(
            &temp_dir,
            &vault_path_string,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "relocated-markdown.png",
        );
        let metadata = crate::metadata_dir(&vault_path_string);
        let export_parent = temp_dir.path().join("markdown-outside");
        let relocated_parent = temp_dir.path().join("markdown-outside-relocated");
        fs::create_dir(&export_parent).expect("create export parent");
        let destination = export_parent.join("relocated.md");
        let raced_parent = export_parent.clone();
        let raced_relocated = relocated_parent.clone();
        let raced_metadata = metadata.clone();
        inject_export_before_publication_once(move || {
            fs::rename(&raced_parent, &raced_relocated).expect("relocate export parent");
            symlink(&raced_metadata, &raced_parent).expect("redirect export parent to metadata");
        });

        let error = notes_export_markdown(
            vault_path_string,
            ROOT_ID.to_string(),
            destination.to_string_lossy().into_owned(),
            true,
        )
        .expect_err("relocated Markdown parent must fail closed");

        assert!(error.contains("identity changed"), "{error}");
        assert!(!metadata.join("relocated.md").exists());
        assert!(!metadata.join("relocated_assets").exists());
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

    #[test]
    fn notes_history_initialize_returns_state_for_the_explicit_session() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();

        let state = notes_initialize_for_session_inner(
            vault_path.clone(),
            NotesInitializeInput {
                session_id: SESSION_ID.to_string(),
            },
        )
        .expect("initialize explicit history session");

        assert!(uuid::Uuid::parse_str(&state.history_epoch).is_ok());
        assert_eq!(state.next_undo_entry_id, None);
        assert_eq!(state.next_redo_entry_id, None);
        assert_eq!(
            state,
            notes_history_status_inner(vault_path, SESSION_ID.to_string())
                .expect("read initialized session state")
        );
    }

    #[test]
    fn notes_history_empty_trash_reset_is_atomic_and_rotates_the_epoch() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        initialize_empty_test_vault(&vault_path);
        let epoch = notes_history_status_inner(vault_path.clone(), SESSION_ID.to_string())
            .expect("initial history state")
            .history_epoch;
        let context = |entry_id: &str, command_kind: &str| NotesHistoryContext {
            session_id: SESSION_ID.to_string(),
            history_epoch: epoch.clone(),
            entry_id: entry_id.to_string(),
            command_kind: command_kind.to_string(),
        };
        notes_create_node(
            vault_path.clone(),
            CreateNodeInput {
                id: ROOT_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "Trash me".to_string(),
                note: String::new(),
            },
            Some(context(REPLACEMENT_ENTRY_ID, "create")),
        )
        .expect("create tracked node");
        notes_soft_delete_node(
            vault_path.clone(),
            ROOT_ID.to_string(),
            Some(context(NOOP_ENTRY_ID, "trash")),
        )
        .expect("trash tracked node");
        let snapshot = |vault_path: &str| {
            let shared = acquire_notes_connection(vault_path).expect("acquire snapshot connection");
            let connection = lock_notes_connection(&shared).expect("lock snapshot connection");
            let rows = connection
                .query_row(
                    "SELECT (SELECT COUNT(*) FROM notes_nodes), \
                            (SELECT COUNT(*) FROM notes_history_entries), \
                            (SELECT value FROM notes_history_epoch)",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .expect("snapshot rows, history, and epoch");
            rows
        };
        let before = snapshot(&vault_path);

        let stale = notes_empty_trash_reset_inner(
            vault_path.clone(),
            NotesHistoryResetInput {
                session_id: SESSION_ID.to_string(),
                history_epoch: "stale-epoch".to_string(),
            },
        )
        .expect_err("reject stale empty-trash reset");
        assert!(stale.to_lowercase().contains("epoch"), "{stale}");
        assert_eq!(snapshot(&vault_path), before);

        {
            let shared = acquire_notes_connection(&vault_path).expect("acquire reset connection");
            let connection = lock_notes_connection(&shared).expect("lock reset connection");
            connection
                .execute_batch(
                    "CREATE TEMP TRIGGER notes_injected_reset_failure \
                     BEFORE DELETE ON notes_nodes BEGIN \
                       SELECT RAISE(ABORT, 'injected reset failure'); \
                     END;",
                )
                .expect("install reset failure trigger");
        }
        let failure = notes_empty_trash_reset_inner(
            vault_path.clone(),
            NotesHistoryResetInput {
                session_id: SESSION_ID.to_string(),
                history_epoch: epoch.clone(),
            },
        )
        .expect_err("roll back failed empty-trash reset");
        assert!(failure.contains("injected reset failure"), "{failure}");
        assert_eq!(snapshot(&vault_path), before);
        {
            let shared = acquire_notes_connection(&vault_path).expect("acquire reset connection");
            let connection = lock_notes_connection(&shared).expect("lock reset connection");
            connection
                .execute_batch("DROP TRIGGER notes_injected_reset_failure;")
                .expect("drop reset failure trigger");
        }

        let reset = notes_empty_trash_reset_inner(
            vault_path.clone(),
            NotesHistoryResetInput {
                session_id: SESSION_ID.to_string(),
                history_epoch: epoch.clone(),
            },
        )
        .expect("commit empty-trash reset");
        assert!(reset.history_reset);
        assert_ne!(reset.history_epoch, epoch);
        assert!(reset.workspace.nodes.is_empty());
        assert_eq!(reset.next_undo_entry_id, None);
        assert_eq!(reset.next_redo_entry_id, None);
        assert_eq!(snapshot(&vault_path).0, 0);
        assert_eq!(history_entry_count(&vault_path), 0);
    }

    #[test]
    fn notes_history_prepare_navigation_rejection_preserves_attachment_files() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        initialize_empty_test_vault(&vault_path);
        let (imported, attachment) =
            import_single_independent_raw_image_node(&vault_path, "navigation.png");
        let asset_path = owned_asset_path(&vault_path, &attachment.relative_path);
        let bytes = fs::read(&asset_path).expect("read history-held asset");
        notes_undo(
            vault_path.clone(),
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("undo image import");
        assert!(asset_path.is_file());

        notes_prepare_navigation_inner(
            vault_path.clone(),
            NotesPrepareNavigationInput {
                session_id: SESSION_ID.to_string(),
                history_epoch: imported.history_epoch.clone(),
                unreachable_redo_entry_ids: Vec::new(),
            },
        )
        .expect_err("reject incomplete redo suffix");
        assert_eq!(history_entry_count(&vault_path), 1);
        assert_eq!(fs::read(&asset_path).expect("read preserved asset"), bytes);

        let state = notes_prepare_navigation_inner(
            vault_path.clone(),
            NotesPrepareNavigationInput {
                session_id: SESSION_ID.to_string(),
                history_epoch: imported.history_epoch.clone(),
                unreachable_redo_entry_ids: vec![REPLACEMENT_ENTRY_ID.to_string()],
            },
        )
        .expect("prune exact redo suffix");
        assert_eq!(state.pruned_entry_ids, vec![REPLACEMENT_ENTRY_ID]);
        assert_eq!(history_entry_count(&vault_path), 0);
        assert!(!asset_path.exists());
    }

    #[test]
    fn notes_history_close_failure_still_evicts_the_cached_connection() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        initialize_empty_test_vault(&vault_path);
        let (imported, _) = import_single_independent_raw_image_node(&vault_path, "close.png");
        notes_undo(
            vault_path.clone(),
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("undo image import before close");
        let cached = acquire_notes_connection(&vault_path).expect("capture cached connection");
        inject_cleanup_failure(CleanupFailurePoint::Reconcile);

        let error = notes_close_history_session_inner(
            vault_path.clone(),
            NotesHistoryCloseInput {
                session_id: SESSION_ID.to_string(),
                history_epoch: imported.history_epoch.clone(),
            },
        )
        .expect_err("surface close reconciliation failure");
        assert!(error.to_lowercase().contains("reconcile"), "{error}");

        let reopened = acquire_notes_connection(&vault_path).expect("reopen after failed close");
        assert!(!std::sync::Arc::ptr_eq(&cached, &reopened));
        let connection = lock_notes_connection(&reopened).expect("lock reopened connection");
        let state = history_state(&connection, SESSION_ID, Vec::new())
            .expect("read fresh reopened history state");
        assert_ne!(state.history_epoch, imported.history_epoch);
        assert_eq!(state.next_undo_entry_id, None);
        assert_eq!(state.next_redo_entry_id, None);
    }

    #[test]
    fn notes_history_final_close_reconciles_history_only_assets_from_every_session() {
        const SECOND_SESSION_ID: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
        const SECOND_ENTRY_ID: &str = "ffffffff-ffff-4fff-8fff-ffffffffffff";

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        initialize_empty_test_vault(&vault_path);
        let epoch = notes_history_status_inner(vault_path.clone(), SESSION_ID.to_string())
            .expect("history state")
            .history_epoch;
        let first = encoded_png(4, 3);
        let second = encoded_png(5, 4);
        let import = |session_id: &str,
                      entry_id: &str,
                      node_id: &str,
                      attachment_id: &str,
                      after_id: Option<&str>,
                      name: &str,
                      bytes: &[u8]| {
            let context = NotesHistoryContext {
                session_id: session_id.to_string(),
                history_epoch: epoch.clone(),
                entry_id: entry_id.to_string(),
                command_kind: "importImageNodes".to_string(),
            };
            let envelope = raw_image_node_envelope(
                &vault_path,
                None,
                after_id,
                &[(node_id, attachment_id, name, "image/png", bytes)],
                Some(&context),
            );
            notes_import_image_node_bytes_body(&envelope).expect("import session image")
        };
        let first_import = import(
            SESSION_ID,
            REPLACEMENT_ENTRY_ID,
            IMAGE_NODE_A_ID,
            IMAGE_ATTACHMENT_A_ID,
            None,
            "first-close.png",
            &first,
        );
        let second_import = import(
            SECOND_SESSION_ID,
            SECOND_ENTRY_ID,
            IMAGE_NODE_B_ID,
            IMAGE_ATTACHMENT_B_ID,
            Some(IMAGE_NODE_A_ID),
            "second-close.png",
            &second,
        );
        let first_asset = owned_asset_path(
            &vault_path,
            &first_import.workspace.attachments_by_node_id[IMAGE_NODE_A_ID][0].relative_path,
        );
        let second_asset = owned_asset_path(
            &vault_path,
            &second_import.workspace.attachments_by_node_id[IMAGE_NODE_B_ID][0].relative_path,
        );

        notes_undo(
            vault_path.clone(),
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("undo first session image");
        notes_undo(
            vault_path.clone(),
            SECOND_SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("undo second session image");
        assert!(first_asset.is_file());
        assert!(second_asset.is_file());

        notes_close_history_session_inner(
            vault_path.clone(),
            NotesHistoryCloseInput {
                session_id: SESSION_ID.to_string(),
                history_epoch: epoch.clone(),
            },
        )
        .expect("close final history connection");

        assert!(!first_asset.exists());
        assert!(!second_asset.exists());
        let reopened = notes_history_status_inner(vault_path, SESSION_ID.to_string())
            .expect("reopen history after close");
        assert_ne!(reopened.history_epoch, epoch);
        assert_eq!(reopened.next_undo_entry_id, None);
        assert_eq!(reopened.next_redo_entry_id, None);
    }

    #[test]
    fn image_atom_receipt_commands_enforce_authority_and_clear_reset_rows() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        initialize_empty_test_vault(&vault_path);
        let epoch = notes_history_status_inner(vault_path.clone(), SESSION_ID.to_string())
            .expect("history epoch")
            .history_epoch;
        let context = NotesHistoryContext {
            session_id: SESSION_ID.to_string(),
            history_epoch: epoch.clone(),
            entry_id: REPLACEMENT_ENTRY_ID.to_string(),
            command_kind: "imageAtomEdit".to_string(),
        };
        notes_create_node(
            vault_path.clone(),
            CreateNodeInput {
                id: ROOT_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "image atom target".to_string(),
                note: String::new(),
            },
            Some(context),
        )
        .expect("create tracked target");
        let receipt = ImageAtomOperationReceiptResult {
            operation_id: REPLACEMENT_ENTRY_ID.to_string(),
            history_epoch: epoch.clone(),
            postcondition_digest: "b".repeat(64),
            affected_root_ids: vec![ROOT_ID.to_string()],
            focus: ImageAtomFocusResult {
                node_id: ROOT_ID.to_string(),
                anchor_utf16: 0,
                focus_utf16: 1,
            },
        };
        {
            let shared = acquire_notes_connection(&vault_path).expect("acquire receipt connection");
            let connection = lock_notes_connection(&shared).expect("lock receipt connection");
            crate::notes::image_atom::record_operation_receipt(
                &connection,
                SESSION_ID,
                "a".repeat(64),
                &receipt,
            )
            .expect("record receipt");
        }

        assert!(matches!(
            notes_lookup_image_atom_operation_inner(
                vault_path.clone(),
                SESSION_ID.to_string(),
                epoch.clone(),
                REPLACEMENT_ENTRY_ID.to_string(),
            )
            .expect("lookup receipt"),
            ImageAtomOperationLookup::Found { receipt: found } if found == receipt
        ));
        assert!(matches!(
            notes_lookup_image_atom_operation_inner(
                vault_path.clone(),
                SESSION_ID.to_string(),
                "stale".to_string(),
                REPLACEMENT_ENTRY_ID.to_string(),
            )
            .expect("epoch mismatch"),
            ImageAtomOperationLookup::EpochMismatch { .. }
        ));
        assert!(notes_lookup_image_atom_operation_inner(
            vault_path.clone(),
            "dddddddd-dddd-4ddd-8ddd-dddddddddddd".to_string(),
            epoch.clone(),
            REPLACEMENT_ENTRY_ID.to_string(),
        )
        .expect_err("foreign session")
        .contains("session"));
        notes_ack_image_atom_operation_inner(
            vault_path.clone(),
            SESSION_ID.to_string(),
            epoch.clone(),
            REPLACEMENT_ENTRY_ID.to_string(),
        )
        .expect("acknowledge receipt");
        notes_ack_image_atom_operation_inner(
            vault_path.clone(),
            SESSION_ID.to_string(),
            epoch.clone(),
            REPLACEMENT_ENTRY_ID.to_string(),
        )
        .expect("repeat acknowledgement");

        let reset = notes_clear_history_reset_inner(
            vault_path.clone(),
            NotesHistoryResetInput {
                session_id: SESSION_ID.to_string(),
                history_epoch: epoch.clone(),
            },
        )
        .expect("clear history");
        let shared = acquire_notes_connection(&vault_path).expect("acquire reset connection");
        let connection = lock_notes_connection(&shared).expect("lock reset connection");
        let receipt_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_image_atom_operations",
                [],
                |row| row.get(0),
            )
            .expect("count reset receipts");
        assert_eq!(receipt_count, 0);
        assert_ne!(reset.history_epoch, epoch);
    }
}
