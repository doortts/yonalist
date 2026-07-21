use crate::notes::connection::{acquire_notes_connection, lock_notes_connection};
use crate::notes::error::{NotesError, NotesErrorCode};
use crate::notes::repository::vault_key;
use crate::notes::sync::asset_gc::{run_asset_gc, AssetGcConfig};
use crate::notes::sync::bootstrap::{flush_pending, reconcile_startup};
use crate::notes::sync::exporter::{
    load_pending_exports, publish_pending_exports_unlocked, quarantine_export_target,
    DebounceSchedule, ExportTarget,
};
use crate::notes::sync::prune_expired_purged_tombstones;
use crate::notes::sync::watcher::{WatchBatchOutcome, WatchProcessor, WatcherRuntime};
use serde::Serialize;
use std::path::Path;
use std::sync::{mpsc, Arc, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::Emitter;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncStatus {
    pub(crate) running: bool,
    pub(crate) dirty_topics: u32,
    pub(crate) quarantined: Vec<String>,
    pub(crate) last_export_at: Option<String>,
    pub(crate) last_merge_at: Option<String>,
    // Track B (B2/B6): the last hard failure that made a worker stop or a
    // topic get quarantined, surfaced so a silent wedge is always visible.
    // Serialized as `lastError`; Track C mirrors it in the TS contract.
    pub(crate) last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncChangedPayload {
    pub(crate) vault_path: String,
    pub(crate) topic_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncStatusPayload {
    pub(crate) vault_path: String,
    pub(crate) status: SyncStatus,
}

pub(crate) trait SyncEventEmitter: Send + Sync {
    fn emit_changed(&self, payload: SyncChangedPayload) -> Result<(), String>;
    fn emit_status(&self, payload: SyncStatusPayload) -> Result<(), String>;
}

#[derive(Default)]
struct NoopSyncEventEmitter;

impl SyncEventEmitter for NoopSyncEventEmitter {
    fn emit_changed(&self, _payload: SyncChangedPayload) -> Result<(), String> {
        Ok(())
    }

    fn emit_status(&self, _payload: SyncStatusPayload) -> Result<(), String> {
        Ok(())
    }
}

struct TauriSyncEventEmitter(tauri::AppHandle);

impl SyncEventEmitter for TauriSyncEventEmitter {
    fn emit_changed(&self, payload: SyncChangedPayload) -> Result<(), String> {
        self.0
            .emit("notes://sync-changed", payload)
            .map_err(|error| format!("Could not emit Notes sync change: {error}"))
    }

    fn emit_status(&self, payload: SyncStatusPayload) -> Result<(), String> {
        self.0
            .emit("notes://sync-status", payload)
            .map_err(|error| format!("Could not emit Notes sync status: {error}"))
    }
}

// B2 test seam: force the exporter loop of one specific vault to panic once.
// Keyed by vault path so parallel tests never trip each other's runtimes.
#[cfg(test)]
static EXPORTER_PANIC_VAULT: Mutex<Option<String>> = Mutex::new(None);

#[cfg(test)]
fn arm_exporter_panic(vault_path: &str) {
    *EXPORTER_PANIC_VAULT
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = Some(vault_path.to_string());
}

#[cfg(test)]
fn maybe_panic_exporter_loop(vault_path: &str) {
    let mut guard = EXPORTER_PANIC_VAULT
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if guard.as_deref() == Some(vault_path) {
        *guard = None;
        panic!("injected Notes exporter panic for test");
    }
}

#[cfg(not(test))]
fn maybe_panic_exporter_loop(_vault_path: &str) {}

fn describe_panic(panic: &(dyn std::any::Any + Send)) -> String {
    if let Some(message) = panic.downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = panic.downcast_ref::<String>() {
        message.clone()
    } else {
        "unknown panic".to_string()
    }
}

/// Builds a status directly from the in-memory clock without touching the
/// database, so it is safe to emit from a panic-recovery path where a lock may
/// be poisoned or the connection unusable.
fn degraded_status(running: bool, times: &RuntimeTimes) -> SyncStatus {
    SyncStatus {
        running,
        dirty_topics: 0,
        quarantined: Vec::new(),
        last_export_at: times.last_export_at.clone(),
        last_merge_at: times.last_merge_at.clone(),
        last_error: times.last_error.clone(),
    }
}

fn emit_worker_panic_status(
    events: &dyn SyncEventEmitter,
    vault_path: &str,
    times: &Mutex<RuntimeTimes>,
    message: String,
) {
    let status = {
        let mut guard = times.lock().unwrap_or_else(PoisonError::into_inner);
        guard.last_error = Some(message);
        degraded_status(false, &guard)
    };
    if let Err(error) = events.emit_status(SyncStatusPayload {
        vault_path: vault_path.to_string(),
        status,
    }) {
        eprintln!("Notes exporter panic status event failed: {error}");
    }
}

#[derive(Debug, Clone, Default)]
struct RuntimeTimes {
    last_export_at: Option<String>,
    last_merge_at: Option<String>,
    // Set when an exporter/watcher loop panics (B2) or a target is quarantined
    // after repeated failures (B6). Cleared on a clean start.
    last_error: Option<String>,
}

enum RuntimeControl {
    Flush(mpsc::Sender<Result<(), String>>),
    Stop(mpsc::Sender<Result<(), String>>),
}

pub(crate) struct SyncRuntime {
    vault_path: String,
    vault_key: String,
    control: mpsc::Sender<RuntimeControl>,
    exporter_worker: Option<JoinHandle<()>>,
    watcher: Option<WatcherRuntime>,
    times: Arc<Mutex<RuntimeTimes>>,
}

impl SyncRuntime {
    fn spawn(
        vault_path: String,
        times: RuntimeTimes,
        pending_cleanup: std::collections::BTreeMap<std::path::PathBuf, String>,
        retry_paths: std::collections::BTreeSet<std::path::PathBuf>,
        events: Arc<dyn SyncEventEmitter>,
        asset_gc_config: AssetGcConfig,
    ) -> Result<Self, String> {
        let (control, receiver) = mpsc::channel();
        let shared_times = Arc::new(Mutex::new(times));
        let worker_times = Arc::clone(&shared_times);
        let worker_vault = vault_path.clone();
        let exporter_events = Arc::clone(&events);
        // B2: keep independent handles so a panic can be caught, recorded, and
        // surfaced as running:false before the exporter thread ends.
        let panic_times = Arc::clone(&shared_times);
        let panic_events = Arc::clone(&events);
        let panic_vault = vault_path.clone();
        let worker = thread::Builder::new()
            .name("notes-sync-exporter".to_string())
            .spawn(move || {
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    exporter_loop(
                        worker_vault,
                        receiver,
                        worker_times,
                        exporter_events,
                        asset_gc_config,
                    )
                }));
                if let Err(panic) = outcome {
                    let message = format!("Notes exporter thread panicked: {}", describe_panic(&panic));
                    eprintln!("{message}");
                    emit_worker_panic_status(
                        panic_events.as_ref(),
                        &panic_vault,
                        &panic_times,
                        message,
                    );
                }
            })
            .map_err(|error| format!("Could not start the Notes exporter: {error}"))?;
        let watcher_vault = vault_path.clone();
        let watcher_times = Arc::clone(&shared_times);
        let watcher_events = Arc::clone(&events);
        let mut initial_paths = retry_paths;
        initial_paths.extend(pending_cleanup.keys().cloned());
        let watch_processor = Arc::new(Mutex::new(WatchProcessor::with_pending_cleanup(
            pending_cleanup,
        )));
        let handler = Arc::new(move |paths: Vec<std::path::PathBuf>| {
            let retry_all = paths.clone();
            // B2: a panic inside a merge must not kill the watcher thread. Catch
            // it, record it for visibility, and retry the batch on the next scan.
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut processor = watch_processor
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                handle_watch_paths_with_processor(
                    &mut processor,
                    &watcher_vault,
                    paths,
                    watcher_events.as_ref(),
                    watcher_times.as_ref(),
                )
            }));
            match outcome {
                Ok(Ok(outcome)) => outcome.retry_paths,
                Ok(Err(error)) => {
                    eprintln!("Notes watcher batch failed and will retry by scan: {error}");
                    retry_all
                }
                Err(panic) => {
                    let message =
                        format!("Notes watcher batch panicked: {}", describe_panic(&panic));
                    eprintln!("{message}");
                    watcher_times
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .last_error = Some(message.clone());
                    if let Err(error) = watcher_events.emit_status(SyncStatusPayload {
                        vault_path: watcher_vault.clone(),
                        status: degraded_status(
                            true,
                            &watcher_times.lock().unwrap_or_else(PoisonError::into_inner),
                        ),
                    }) {
                        eprintln!("Notes watcher panic status event failed: {error}");
                    }
                    retry_all
                }
            }
        });
        let watcher = match WatcherRuntime::spawn(
            crate::expand_vault_path(&vault_path),
            initial_paths.into_iter().collect(),
            handler,
        ) {
            Ok(watcher) => watcher,
            Err(error) => {
                let (reply, response) = mpsc::channel();
                let _ = control.send(RuntimeControl::Stop(reply));
                let _ = response.recv();
                let _ = worker.join();
                return Err(error);
            }
        };
        Ok(Self {
            vault_key: vault_key(&vault_path),
            vault_path,
            control,
            exporter_worker: Some(worker),
            watcher: Some(watcher),
            times: shared_times,
        })
    }

    /// B2: the exporter thread ending while the runtime slot is still populated
    /// means it panicked (it otherwise only ends on Stop). A dead exporter makes
    /// the runtime unhealthy so `notes_sync_start` can restart it.
    fn is_healthy(&self) -> bool {
        self.exporter_worker
            .as_ref()
            .is_some_and(|worker| !worker.is_finished())
    }

    fn request_flush(&self) -> Result<(), String> {
        let (reply, response) = mpsc::channel();
        self.control
            .send(RuntimeControl::Flush(reply))
            .map_err(|_| "The Notes exporter is not running.".to_string())?;
        response
            .recv()
            .map_err(|_| "The Notes exporter stopped before flush completed.".to_string())?
    }

    fn stop(&mut self) -> Result<(), String> {
        let watcher_result = self
            .watcher
            .as_mut()
            .map(WatcherRuntime::stop)
            .unwrap_or(Ok(()));
        self.watcher = None;
        let flush_result = if self.exporter_worker.is_some() {
            let (reply, response) = mpsc::channel();
            self.control
                .send(RuntimeControl::Stop(reply))
                .map_err(|_| "The Notes exporter is not running.".to_string())?;
            response.recv().map_err(|_| {
                "The Notes exporter stopped before its final flush completed.".to_string()
            })?
        } else {
            Ok(())
        };
        if let Some(worker) = self.exporter_worker.take() {
            worker
                .join()
                .map_err(|_| "The Notes exporter thread panicked.".to_string())?;
        }
        watcher_result.and(flush_result)
    }
}

impl Drop for SyncRuntime {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[derive(Clone, Default)]
pub(crate) struct SyncState(pub(crate) Arc<Mutex<Option<SyncRuntime>>>);

fn lock_state(state: &SyncState) -> MutexGuard<'_, Option<SyncRuntime>> {
    state.0.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(crate) fn start_sync(state: &SyncState, vault_path: String) -> Result<SyncStatus, String> {
    start_sync_with_events_and_config(
        state,
        vault_path,
        Arc::new(NoopSyncEventEmitter),
        AssetGcConfig::default(),
    )
}

fn start_sync_with_events(
    state: &SyncState,
    vault_path: String,
    events: Arc<dyn SyncEventEmitter>,
) -> Result<SyncStatus, String> {
    start_sync_with_events_and_config(state, vault_path, events, AssetGcConfig::default())
}

fn start_sync_with_events_and_config(
    state: &SyncState,
    vault_path: String,
    events: Arc<dyn SyncEventEmitter>,
    asset_gc_config: AssetGcConfig,
) -> Result<SyncStatus, String> {
    let asset_gc_config = asset_gc_config.validate()?;
    let requested_key = vault_key(&vault_path);
    let mut runtime_slot = lock_state(state);
    // B2: idempotent only while the running runtime is healthy. A runtime whose
    // exporter thread panicked falls through to a clean restart below.
    if runtime_slot
        .as_ref()
        .is_some_and(|runtime| runtime.vault_key == requested_key && runtime.is_healthy())
    {
        return status_for_runtime(runtime_slot.as_ref(), &vault_path);
    }
    if let Some(mut previous) = runtime_slot.take() {
        // B7: a stale/dead runtime or a vault switch must not hard-fail the
        // start. A failed final export stays dirty and retries later.
        if let Err(error) = previous.stop() {
            eprintln!("Notes sync teardown before restart failed and was ignored: {error}");
        }
    }
    let bootstrap = reconcile_startup(&vault_path)?;
    if !bootstrap.errors.is_empty() {
        eprintln!(
            "Notes sync startup completed with retryable target failures: {}",
            bootstrap.errors.join("; ")
        );
    }
    let startup_changed_topic_ids = bootstrap.changed_topic_ids.into_iter().collect::<Vec<_>>();
    let startup_status_changed = bootstrap.status_changed;
    let runtime = SyncRuntime::spawn(
        vault_path.clone(),
        RuntimeTimes {
            last_export_at: bootstrap.last_export_at,
            last_merge_at: bootstrap.last_merge_at,
            last_error: None,
        },
        bootstrap.pending_cleanup,
        bootstrap.retry_paths,
        Arc::clone(&events),
        asset_gc_config,
    )?;
    *runtime_slot = Some(runtime);
    if !startup_changed_topic_ids.is_empty() {
        if let Err(error) = events.emit_changed(SyncChangedPayload {
            vault_path: vault_path.clone(),
            topic_ids: startup_changed_topic_ids,
        }) {
            eprintln!("Notes startup change event failed: {error}");
        }
    }
    let status = status_for_runtime(runtime_slot.as_ref(), &vault_path)?;
    if startup_status_changed {
        if let Err(error) = events.emit_status(SyncStatusPayload {
            vault_path: vault_path.clone(),
            status: status.clone(),
        }) {
            eprintln!("Notes startup status event failed: {error}");
        }
    }
    Ok(status)
}

pub(crate) fn stop_sync(state: &SyncState) -> Result<(), String> {
    let mut runtime_slot = lock_state(state);
    if let Some(mut runtime) = runtime_slot.take() {
        runtime.stop()?;
    }
    Ok(())
}

pub(crate) fn flush_sync(state: &SyncState, vault_path: String) -> Result<(), String> {
    let requested_key = vault_key(&vault_path);
    let runtime_slot = lock_state(state);
    if let Some(runtime) = runtime_slot.as_ref() {
        if runtime.vault_key != requested_key {
            return Err("The requested Notes vault is not the running sync vault.".to_string());
        }
        return runtime.request_flush();
    }
    drop(runtime_slot);
    let shared = acquire_notes_connection(&vault_path)?;
    let mut connection = lock_notes_connection(&shared)?;
    flush_pending(&mut connection, &crate::expand_vault_path(&vault_path)).map(drop)
}

pub(crate) fn sync_status(state: &SyncState, vault_path: String) -> Result<SyncStatus, String> {
    let runtime_slot = lock_state(state);
    status_for_runtime(runtime_slot.as_ref(), &vault_path)
}

fn status_for_runtime(
    runtime: Option<&SyncRuntime>,
    vault_path: &str,
) -> Result<SyncStatus, String> {
    let requested_key = vault_key(vault_path);
    let running_runtime = runtime.filter(|runtime| runtime.vault_key == requested_key);
    let times = running_runtime
        .map(|runtime| {
            runtime
                .times
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        })
        .unwrap_or_default();
    // B2: a runtime whose exporter thread has died reports running:false even
    // though the slot is still populated, so a crashed worker is never hidden.
    let running = running_runtime.is_some_and(SyncRuntime::is_healthy);
    load_status_from_storage(vault_path, running, times)
}

fn load_status_from_storage(
    vault_path: &str,
    running: bool,
    times: RuntimeTimes,
) -> Result<SyncStatus, String> {
    let shared = acquire_notes_connection(vault_path)?;
    let connection = lock_notes_connection(&shared)?;
    let dirty_topics = u32::try_from(load_pending_exports(&connection)?.len())
        .map_err(|_| "The Notes dirty topic count is too large.".to_string())?;
    let mut statement = connection
        .prepare("SELECT file_name FROM sync_topics WHERE quarantined <> 0 ORDER BY file_name")
        .map_err(|error| format!("Could not prepare Notes quarantine status: {error}"))?;
    let quarantined = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Could not load Notes quarantine status: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read Notes quarantine status: {error}"))?;
    Ok(SyncStatus {
        running,
        dirty_topics,
        quarantined,
        last_export_at: times.last_export_at,
        last_merge_at: times.last_merge_at,
        last_error: times.last_error,
    })
}

fn handle_watch_paths<I, P>(
    vault_path: &str,
    paths: I,
    events: &dyn SyncEventEmitter,
    times: &Mutex<RuntimeTimes>,
) -> Result<WatchBatchOutcome, String>
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    let mut processor = WatchProcessor::default();
    handle_watch_paths_with_processor(&mut processor, vault_path, paths, events, times)
}

fn handle_watch_paths_with_processor<I, P>(
    processor: &mut WatchProcessor,
    vault_path: &str,
    paths: I,
    events: &dyn SyncEventEmitter,
    times: &Mutex<RuntimeTimes>,
) -> Result<WatchBatchOutcome, String>
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    let outcome = processor.process(vault_path, paths)?;
    if !outcome.changed_topic_ids.is_empty() {
        let shared = acquire_notes_connection(vault_path)?;
        let connection = lock_notes_connection(&shared)?;
        let timestamp: String = connection
            .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
                row.get(0)
            })
            .map_err(|error| format!("Could not record Notes watcher merge time: {error}"))?;
        times
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .last_merge_at = Some(timestamp);
    }
    if !outcome.changed_topic_ids.is_empty() || outcome.asset_changed {
        events.emit_changed(SyncChangedPayload {
            vault_path: vault_path.to_string(),
            topic_ids: outcome.changed_topic_ids.clone(),
        })?;
    }
    if outcome.status_changed {
        let snapshot = times.lock().unwrap_or_else(PoisonError::into_inner).clone();
        events.emit_status(SyncStatusPayload {
            vault_path: vault_path.to_string(),
            status: load_status_from_storage(vault_path, true, snapshot)?,
        })?;
    }
    for error in &outcome.errors {
        eprintln!("Notes watcher target failed and remains retryable: {error}");
    }
    Ok(outcome)
}

#[cfg(test)]
pub(crate) fn active_vault_path(state: &SyncState) -> Option<String> {
    lock_state(state)
        .as_ref()
        .map(|runtime| runtime.vault_path.clone())
}

#[cfg(test)]
pub(crate) fn active_worker_threads(state: &SyncState) -> Option<(bool, bool)> {
    lock_state(state).as_ref().map(|runtime| {
        (
            runtime.exporter_worker.is_some(),
            runtime
                .watcher
                .as_ref()
                .is_some_and(WatcherRuntime::is_running),
        )
    })
}

fn exporter_loop(
    vault_path: String,
    receiver: mpsc::Receiver<RuntimeControl>,
    times: Arc<Mutex<RuntimeTimes>>,
    events: Arc<dyn SyncEventEmitter>,
    asset_gc_config: AssetGcConfig,
) {
    let started_at = Instant::now();
    let mut schedule = DebounceSchedule::default();
    let mut failures = FailureTracker::default();
    let mut last_asset_gc_at = Duration::ZERO;
    loop {
        maybe_panic_exporter_loop(&vault_path);
        // ponytail: 1s poll, 이벤트 채널로 교체 가능
        let (force, reply, should_stop) = match receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(RuntimeControl::Flush(reply)) => (true, Some(reply), false),
            Ok(RuntimeControl::Stop(reply)) => (true, Some(reply), true),
            Err(mpsc::RecvTimeoutError::Timeout) => (false, None, false),
            Err(mpsc::RecvTimeoutError::Disconnected) => (true, None, true),
        };
        let before = times.lock().unwrap_or_else(PoisonError::into_inner).clone();
        let result = run_export_cycle(
            &vault_path,
            &mut schedule,
            &mut failures,
            started_at.elapsed(),
            force,
            &times,
        );
        let snapshot = times.lock().unwrap_or_else(PoisonError::into_inner).clone();
        // Emit whenever an export landed or a target was quarantined (B6) —
        // a quarantine changes lastError without touching lastExportAt.
        if snapshot.last_export_at != before.last_export_at
            || snapshot.last_error != before.last_error
        {
            match load_status_from_storage(&vault_path, true, snapshot) {
                Ok(status) => {
                    if let Err(error) = events.emit_status(SyncStatusPayload {
                        vault_path: vault_path.clone(),
                        status,
                    }) {
                        eprintln!("Notes exporter status event failed: {error}");
                    }
                }
                Err(error) => eprintln!("Notes exporter status load failed: {error}"),
            }
        }
        if let Some(reply) = reply {
            let _ = reply.send(result);
        } else if let Err(error) = result {
            eprintln!("Notes exporter cycle failed: {error}");
        }
        let now = started_at.elapsed();
        if asset_gc_due(&mut last_asset_gc_at, now) {
            if let Err(error) = run_asset_gc(&vault_path, asset_gc_config) {
                eprintln!("Notes asset GC cycle failed: {error}");
            }
            if let Err(error) = prune_purged_tombstones(&vault_path) {
                eprintln!("Notes purge-evidence maintenance failed: {error}");
            }
            // B7: sweep retired bounced copies older than 30 days.
            if let Err(error) =
                crate::notes::sync::bootstrap::prune_consumed_cleanup(&crate::expand_vault_path(
                    &vault_path,
                ))
            {
                eprintln!("Notes retired-cleanup maintenance failed: {error}");
            }
        }
        if should_stop {
            break;
        }
    }
}

fn prune_purged_tombstones(vault_path: &str) -> Result<(), String> {
    let shared = acquire_notes_connection(vault_path)?;
    let connection = lock_notes_connection(&shared)?;
    prune_expired_purged_tombstones(&connection)?;
    Ok(())
}

fn asset_gc_due(last_run: &mut Duration, now: Duration) -> bool {
    if now.saturating_sub(*last_run) < Duration::from_secs(60) {
        return false;
    }
    *last_run = now;
    true
}

/// Rule 11: bans the permanent silent retry. Counts consecutive export
/// failures per target and only reports "quarantine now" once the same target
/// has failed with the identical error three ticks running.
const MAX_CONSECUTIVE_EXPORT_FAILURES: u32 = 3;

#[derive(Default)]
struct FailureTracker {
    counts: std::collections::BTreeMap<ExportTarget, (String, u32)>,
}

impl FailureTracker {
    fn record_failure(&mut self, target: &ExportTarget, error: &str) -> Option<String> {
        let entry = self
            .counts
            .entry(target.clone())
            .or_insert_with(|| (String::new(), 0));
        if entry.0 == error {
            entry.1 += 1;
        } else {
            entry.0 = error.to_string();
            entry.1 = 1;
        }
        if entry.1 < MAX_CONSECUTIVE_EXPORT_FAILURES {
            return None;
        }
        let reason = entry.0.clone();
        self.counts.remove(target);
        Some(reason)
    }

    fn record_success(&mut self, target: &ExportTarget) {
        self.counts.remove(target);
    }
}

fn run_export_cycle(
    vault_path: &str,
    schedule: &mut DebounceSchedule,
    failures: &mut FailureTracker,
    now: Duration,
    force: bool,
    times: &Mutex<RuntimeTimes>,
) -> Result<(), String> {
    let shared = acquire_notes_connection(vault_path)?;
    let vault_root = crate::expand_vault_path(vault_path);
    // Decide what is due while holding the lock briefly, then release it: the
    // atomic writes in `publish_pending_exports_unlocked` run unlocked (B4).
    let selected: Vec<_> = {
        let connection = lock_notes_connection(&shared)?;
        let pending = load_pending_exports(&connection)?;
        let observed = pending
            .iter()
            .map(|(target, pending)| (target.clone(), pending.fingerprint.clone()))
            .collect();
        let due = schedule.due(now, observed, force);
        due.iter()
            .filter_map(|target| pending.get(target).cloned())
            .collect()
    };
    if selected.is_empty() {
        return Ok(());
    }
    let outcome = publish_pending_exports_unlocked(&shared, &vault_root, selected)?;
    for target in &outcome.succeeded {
        schedule.complete(target);
        failures.record_success(target);
    }
    for (target, error) in &outcome.failed {
        if let Some(reason) = failures.record_failure(target, error) {
            {
                let connection = lock_notes_connection(&shared)?;
                quarantine_export_target(&connection, target, &reason)?;
            }
            schedule.complete(target);
            times.lock().unwrap_or_else(PoisonError::into_inner).last_error = Some(reason);
        }
    }
    if outcome.exported != 0 {
        let connection = lock_notes_connection(&shared)?;
        let timestamp: String = connection
            .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
                row.get(0)
            })
            .map_err(|error| format!("Could not record Notes export time: {error}"))?;
        times
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .last_export_at = Some(timestamp);
    }
    outcome.result()
}

async fn run_blocking<T>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, NotesError>
where
    T: Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(operation).await {
        Ok(result) => result.map_err(NotesError::from),
        Err(error) => Err(NotesError::new(
            NotesErrorCode::Internal,
            format!("Notes sync background task failed: {error}"),
        )),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_sync_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, SyncState>,
    vault_path: String,
    config: AssetGcConfig,
) -> Result<SyncStatus, NotesError> {
    let state = state.inner().clone();
    run_blocking(move || {
        start_sync_with_events_and_config(
            &state,
            vault_path,
            Arc::new(TauriSyncEventEmitter(app)),
            config,
        )
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_sync_stop(state: tauri::State<'_, SyncState>) -> Result<(), NotesError> {
    let state = state.inner().clone();
    run_blocking(move || stop_sync(&state)).await
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_sync_flush(
    state: tauri::State<'_, SyncState>,
    vault_path: String,
) -> Result<(), NotesError> {
    let state = state.inner().clone();
    run_blocking(move || flush_sync(&state, vault_path)).await
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_sync_status(
    state: tauri::State<'_, SyncState>,
    vault_path: String,
) -> Result<SyncStatus, NotesError> {
    let state = state.inner().clone();
    run_blocking(move || sync_status(&state, vault_path)).await
}

#[cfg(test)]
mod tests {
    use super::{
        active_vault_path, active_worker_threads, arm_exporter_panic, asset_gc_due, flush_sync,
        handle_watch_paths, run_export_cycle, start_sync, start_sync_with_events, stop_sync,
        DebounceSchedule, ExportTarget, FailureTracker, RuntimeTimes, SyncChangedPayload,
        SyncEventEmitter, SyncState, SyncStatusPayload,
    };
    use crate::notes::connection::{
        acquire_notes_connection, evict_notes_connection, lock_notes_connection,
    };
    use rusqlite::{params, OptionalExtension};
    use serde_json::json;
    use std::fs;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct RecordingEvents {
        changed: Mutex<Vec<SyncChangedPayload>>,
        statuses: Mutex<Vec<SyncStatusPayload>>,
    }

    impl SyncEventEmitter for RecordingEvents {
        fn emit_changed(&self, payload: SyncChangedPayload) -> Result<(), String> {
            self.changed.lock().unwrap().push(payload);
            Ok(())
        }

        fn emit_status(&self, payload: SyncStatusPayload) -> Result<(), String> {
            self.statuses.lock().unwrap().push(payload);
            Ok(())
        }
    }

    const TOPIC_ID: &str = "11111111-1111-4111-8111-111111111111";
    const BROKEN_CHILD_ID: &str = "22222222-2222-4222-8222-222222222222";
    const HEALTHY_TOPIC_ID: &str = "33333333-3333-4333-8333-333333333333";
    const HLC_1: &str = "000000001-00-a3f2";
    const HLC_2: &str = "000000002-00-a3f2";
    const HLC_3: &str = "000000003-00-a3f2";

    #[test]
    fn asset_gc_tick_runs_at_most_once_per_sixty_seconds() {
        let mut last_run = std::time::Duration::ZERO;
        assert!(!asset_gc_due(
            &mut last_run,
            std::time::Duration::from_secs(59)
        ));
        assert!(asset_gc_due(
            &mut last_run,
            std::time::Duration::from_secs(60)
        ));
        assert!(!asset_gc_due(
            &mut last_run,
            std::time::Duration::from_secs(119)
        ));
        assert!(asset_gc_due(
            &mut last_run,
            std::time::Duration::from_secs(120)
        ));
    }

    fn vault_string(vault: &tempfile::TempDir) -> String {
        vault.path().to_str().expect("utf-8 vault").to_string()
    }

    fn seed_topic(vault_path: &str) {
        let shared = acquire_notes_connection(vault_path).expect("initialize database");
        let connection = lock_notes_connection(&shared).expect("lock database");
        connection.execute("DELETE FROM notes_nodes", []).unwrap();
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO notes_nodes(id, parent_id, sort_key, title, created_at, updated_at, hlc) \
                 VALUES (?1, NULL, 1024, 'Runtime topic', '2026-07-21T00:00:00.000Z', \
                         '2026-07-21T00:00:00.000Z', ?2)",
                params![TOPIC_ID, HLC_1],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1)",
                [TOPIC_ID],
            )
            .unwrap();
    }

    fn update_topic(vault_path: &str, title: &str, hlc: &str) {
        let shared = acquire_notes_connection(vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        connection
            .execute(
                "UPDATE notes_nodes SET title = ?1, hlc = ?2 WHERE id = ?3",
                params![title, hlc, TOPIC_ID],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1) \
                 ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at",
                [TOPIC_ID],
            )
            .unwrap();
    }

    #[test]
    fn repeated_start_stop_and_vault_switch_are_idempotent() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let first_path = vault_string(&first);
        let second_path = vault_string(&second);
        seed_topic(&first_path);
        seed_topic(&second_path);
        let state = SyncState::default();

        assert!(start_sync(&state, first_path.clone()).unwrap().running);
        assert!(start_sync(&state, first_path.clone()).unwrap().running);
        assert_eq!(
            active_vault_path(&state).as_deref(),
            Some(first_path.as_str())
        );
        assert_eq!(active_worker_threads(&state), Some((true, true)));
        assert!(start_sync(&state, second_path.clone()).unwrap().running);
        assert_eq!(
            active_vault_path(&state).as_deref(),
            Some(second_path.as_str())
        );
        assert_eq!(active_worker_threads(&state), Some((true, true)));
        stop_sync(&state).unwrap();
        stop_sync(&state).unwrap();
        assert_eq!(active_vault_path(&state), None);
        assert_eq!(active_worker_threads(&state), None);
        evict_notes_connection(&first_path);
        evict_notes_connection(&second_path);
    }

    #[test]
    fn flush_and_stop_bypass_the_debounce_window() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault_string(&vault);
        seed_topic(&vault_path);
        let state = SyncState::default();
        start_sync(&state, vault_path.clone()).unwrap();
        let file_name = active_topic_filename(&vault_path);

        update_topic(&vault_path, "Flushed now", HLC_2);
        flush_sync(&state, vault_path.clone()).unwrap();
        assert!(fs::read_to_string(vault.path().join(&file_name))
            .unwrap()
            .contains("# Flushed now"));

        update_topic(&vault_path, "Stopped now", HLC_3);
        stop_sync(&state).unwrap();
        assert!(fs::read_to_string(vault.path().join(file_name))
            .unwrap()
            .contains("# Stopped now"));
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn start_survives_one_export_failure_and_surfaces_retryable_status() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault_string(&vault);
        seed_topic(&vault_path);
        let shared = acquire_notes_connection(&vault_path).unwrap();
        {
            let connection = lock_notes_connection(&shared).unwrap();
            connection
                .execute(
                    "INSERT INTO notes_nodes(\
                       id, parent_id, sort_key, title, note, image_offset_utf16, node_kind, \
                       created_at, updated_at, hlc\
                     ) VALUES (?1, ?2, 1024, 'Broken image', '', 0, 'image', \
                               '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z', ?3)",
                    params![BROKEN_CHILD_ID, TOPIC_ID, HLC_1],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO notes_nodes(id, parent_id, sort_key, title, created_at, updated_at, hlc) \
                     VALUES (?1, NULL, 2048, 'Healthy runtime topic', \
                             '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z', ?2)",
                    params![HEALTHY_TOPIC_ID, HLC_1],
                )
                .unwrap();
            connection
                .execute("DELETE FROM sync_dirty_nodes", [])
                .unwrap();
        }
        drop(shared);
        let state = SyncState::default();

        let status = start_sync(&state, vault_path.clone())
            .expect("bootstrap target failure must not stop runtime");

        assert!(status.running);
        assert_eq!(status.dirty_topics, 1);
        assert!(vault
            .path()
            .join("Healthy-runtime-topic.33333333.md")
            .is_file());
        let stop_error = stop_sync(&state).expect_err("broken export remains retryable");
        assert!(stop_error.contains("must own exactly one attachment"));
        evict_notes_connection(&vault_path);
    }

    fn active_topic_filename(vault_path: &str) -> String {
        let shared = acquire_notes_connection(vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        connection
            .query_row(
                "SELECT file_name FROM sync_topics WHERE topic_id = ?1",
                [TOPIC_ID],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn direct_watcher_callback_emits_the_exact_changed_payload_after_merge() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault_string(&vault);
        seed_topic(&vault_path);
        crate::notes::sync::bootstrap::reconcile_startup(&vault_path).unwrap();
        let source = vault.path().join(active_topic_filename(&vault_path));
        let bytes = crate::notes::sync::topic_file::render_topic_doc(
            &crate::notes::sync::topic_file::TopicDoc {
                id: TOPIC_ID.to_string(),
                sort_key: 1024,
                max_hlc: HLC_2.to_string(),
                root: crate::notes::sync::topic_file::TopicRoot {
                    title: "Remote watcher edit".to_string(),
                    hlc: HLC_2.to_string(),
                    starred: false,
                    completed_at: None,
                    archived_at: None,
                },
                nodes: Vec::new(),
            },
        )
        .unwrap();
        fs::write(&source, bytes).unwrap();
        let events = RecordingEvents::default();
        let times = Mutex::new(RuntimeTimes::default());

        handle_watch_paths(&vault_path, [&source], &events, &times).unwrap();

        let changed = events.changed.lock().unwrap();
        assert_eq!(changed.len(), 1);
        assert_eq!(
            serde_json::to_value(&changed[0]).unwrap(),
            json!({"vaultPath": vault_path, "topicIds": [TOPIC_ID]})
        );
        assert!(events.statuses.lock().unwrap().is_empty());
        assert!(times.lock().unwrap().last_merge_at.is_some());
        drop(changed);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn startup_reconciliation_emits_the_exact_changed_payload_after_listener_registration() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault_string(&vault);
        let source = vault.path().join("remote.11111111.md");
        fs::write(
            source,
            crate::notes::sync::topic_file::render_topic_doc(
                &crate::notes::sync::topic_file::TopicDoc {
                    id: TOPIC_ID.to_string(),
                    sort_key: 1024,
                    max_hlc: HLC_1.to_string(),
                    root: crate::notes::sync::topic_file::TopicRoot {
                        title: "Remote startup edit".to_string(),
                        hlc: HLC_1.to_string(),
                        starred: false,
                        completed_at: None,
                        archived_at: None,
                    },
                    nodes: Vec::new(),
                },
            )
            .unwrap(),
        )
        .unwrap();
        let state = SyncState::default();
        let events = Arc::new(RecordingEvents::default());
        let runtime_events: Arc<dyn SyncEventEmitter> = events.clone();

        start_sync_with_events(&state, vault_path.clone(), runtime_events).unwrap();

        assert_eq!(
            events.changed.lock().unwrap().as_slice(),
            &[SyncChangedPayload {
                vault_path: vault_path.clone(),
                topic_ids: vec![TOPIC_ID.to_string()]
            }]
        );
        stop_sync(&state).unwrap();
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn startup_reconciliation_schedules_a_preexisting_bounced_copy_for_cleanup() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault_string(&vault);
        let canonical = vault.path().join("topic.11111111.md");
        let bounced = vault.path().join("topic 2.md");
        let render = |title: &str, hlc: &str| {
            crate::notes::sync::topic_file::render_topic_doc(
                &crate::notes::sync::topic_file::TopicDoc {
                    id: TOPIC_ID.to_string(),
                    sort_key: 1024,
                    max_hlc: hlc.to_string(),
                    root: crate::notes::sync::topic_file::TopicRoot {
                        title: title.to_string(),
                        hlc: hlc.to_string(),
                        starred: false,
                        completed_at: None,
                        archived_at: None,
                    },
                    nodes: Vec::new(),
                },
            )
            .unwrap()
        };
        fs::write(&canonical, render("Before", HLC_1)).unwrap();
        crate::notes::sync::bootstrap::reconcile_startup(&vault_path).unwrap();
        fs::write(&bounced, render("From closed app", HLC_2)).unwrap();
        let state = SyncState::default();
        let events = Arc::new(RecordingEvents::default());
        let runtime_events: Arc<dyn SyncEventEmitter> = events.clone();

        start_sync_with_events(&state, vault_path.clone(), runtime_events).unwrap();

        for _ in 0..40 {
            if !bounced.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(!bounced.exists(), "startup bounce must enter cleanup retry");
        assert_eq!(
            events.changed.lock().unwrap().as_slice(),
            &[SyncChangedPayload {
                vault_path: vault_path.clone(),
                topic_ids: vec![TOPIC_ID.to_string()]
            }]
        );
        stop_sync(&state).unwrap();
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn fresh_start_prefers_the_canonical_topic_filename_over_a_lexically_earlier_bounce() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault_string(&vault);
        let canonical = vault.path().join("Topic.11111111.md");
        let bounced = vault.path().join("Topic.11111111 2.md");
        let render = |title: &str, hlc: &str| {
            crate::notes::sync::topic_file::render_topic_doc(
                &crate::notes::sync::topic_file::TopicDoc {
                    id: TOPIC_ID.to_string(),
                    sort_key: 1024,
                    max_hlc: hlc.to_string(),
                    root: crate::notes::sync::topic_file::TopicRoot {
                        title: title.to_string(),
                        hlc: hlc.to_string(),
                        starred: false,
                        completed_at: None,
                        archived_at: None,
                    },
                    nodes: Vec::new(),
                },
            )
            .unwrap()
        };
        fs::write(&canonical, render("Canonical", HLC_1)).unwrap();
        fs::write(&bounced, render("Newer bounce", HLC_2)).unwrap();
        let state = SyncState::default();

        start_sync(&state, vault_path.clone()).unwrap();

        for _ in 0..40 {
            if !bounced.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(
            canonical.is_file(),
            "canonical source must survive fresh bootstrap"
        );
        assert!(
            !bounced.exists(),
            "fresh bootstrap must retire only the bounce"
        );
        assert_eq!(active_topic_filename(&vault_path), "Topic.11111111.md");
        stop_sync(&state).unwrap();
        evict_notes_connection(&vault_path);
    }

    #[cfg(unix)]
    #[test]
    fn fresh_start_preserves_an_unreadable_canonical_file_until_bounce_recovery() {
        use std::os::unix::fs::PermissionsExt;

        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault_string(&vault);
        let canonical = vault.path().join("Topic.11111111.md");
        let bounced = vault.path().join("Topic.11111111 2.md");
        let render = |title: &str, hlc: &str| {
            crate::notes::sync::topic_file::render_topic_doc(
                &crate::notes::sync::topic_file::TopicDoc {
                    id: TOPIC_ID.to_string(),
                    sort_key: 1024,
                    max_hlc: hlc.to_string(),
                    root: crate::notes::sync::topic_file::TopicRoot {
                        title: title.to_string(),
                        hlc: hlc.to_string(),
                        starred: false,
                        completed_at: None,
                        archived_at: None,
                    },
                    nodes: Vec::new(),
                },
            )
            .unwrap()
        };
        fs::write(&canonical, render("Canonical", HLC_1)).unwrap();
        fs::write(&bounced, render("Newer bounce", HLC_2)).unwrap();
        fs::set_permissions(&canonical, fs::Permissions::from_mode(0o000)).unwrap();
        let state = SyncState::default();

        start_sync(&state, vault_path.clone()).unwrap();
        stop_sync(&state).unwrap();
        assert!(canonical.exists());
        assert!(bounced.exists());

        fs::set_permissions(&canonical, fs::Permissions::from_mode(0o600)).unwrap();
        start_sync(&state, vault_path.clone()).unwrap();
        for _ in 0..40 {
            if !bounced.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        assert!(
            canonical.is_file(),
            "canonical source must survive recovery"
        );
        assert!(!bounced.exists(), "only the bounced copy may be retired");
        assert_eq!(active_topic_filename(&vault_path), "Topic.11111111.md");
        stop_sync(&state).unwrap();
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn startup_quarantine_emits_the_post_start_status_snapshot() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault_string(&vault);
        fs::write(vault.path().join("broken.md"), b"not a Notes topic").unwrap();
        let state = SyncState::default();
        let events = Arc::new(RecordingEvents::default());
        let runtime_events: Arc<dyn SyncEventEmitter> = events.clone();

        start_sync_with_events(&state, vault_path.clone(), runtime_events).unwrap();

        let statuses = events.statuses.lock().unwrap();
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].vault_path, vault_path);
        assert!(statuses[0].status.running);
        assert_eq!(statuses[0].status.quarantined, vec!["broken.md"]);
        drop(statuses);
        stop_sync(&state).unwrap();
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn startup_truncation_emits_quarantine_then_recovery_status() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault_string(&vault);
        let source_name = "Stable.11111111.md";
        let source = vault.path().join(source_name);
        let canonical = crate::notes::sync::topic_file::render_topic_doc(
            &crate::notes::sync::topic_file::TopicDoc {
                id: TOPIC_ID.to_string(),
                sort_key: 1024,
                max_hlc: HLC_2.to_string(),
                root: crate::notes::sync::topic_file::TopicRoot {
                    title: "Stable".to_string(),
                    hlc: HLC_1.to_string(),
                    starred: false,
                    completed_at: None,
                    archived_at: None,
                },
                nodes: vec![crate::notes::sync::topic_file::TopicNode {
                    id: Some(BROKEN_CHILD_ID.to_string()),
                    hlc: HLC_2.to_string(),
                    starred: false,
                    completed: false,
                    content: crate::notes::sync::topic_file::TopicContent::Text(
                        "Child".to_string(),
                    ),
                    note: String::new(),
                    from: None,
                    sibling_ordinal: 1,
                    sort_key: 1024,
                    children: Vec::new(),
                }],
            },
        )
        .unwrap();
        fs::write(&source, &canonical).unwrap();
        crate::notes::sync::bootstrap::reconcile_startup(&vault_path).unwrap();
        let first_bullet = canonical
            .windows(b"- [ ]".len())
            .position(|window| window == b"- [ ]")
            .unwrap();
        fs::write(&source, &canonical[..first_bullet]).unwrap();
        let state = SyncState::default();
        let events = Arc::new(RecordingEvents::default());
        let runtime_events: Arc<dyn SyncEventEmitter> = events.clone();

        start_sync_with_events(&state, vault_path.clone(), runtime_events).unwrap();
        for _ in 0..40 {
            if events.statuses.lock().unwrap().len() >= 2 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        let statuses = events.statuses.lock().unwrap();
        assert!(statuses.len() >= 2, "recovery must emit both status edges");
        assert_eq!(statuses[0].status.quarantined, vec![source_name]);
        assert!(statuses.last().unwrap().status.quarantined.is_empty());
        drop(statuses);
        stop_sync(&state).unwrap();
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn watcher_quarantine_and_recovery_emit_exact_status_snapshots() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault_string(&vault);
        crate::notes::sync::bootstrap::reconcile_startup(&vault_path).unwrap();
        let source = vault.path().join("recovered.md");
        fs::write(&source, b"not a topic file").unwrap();
        let events = RecordingEvents::default();
        let times = Mutex::new(RuntimeTimes::default());

        handle_watch_paths(&vault_path, [&source], &events, &times).unwrap();
        fs::write(
            &source,
            crate::notes::sync::topic_file::render_topic_doc(
                &crate::notes::sync::topic_file::TopicDoc {
                    id: TOPIC_ID.to_string(),
                    sort_key: 1024,
                    max_hlc: HLC_1.to_string(),
                    root: crate::notes::sync::topic_file::TopicRoot {
                        title: "Recovered".to_string(),
                        hlc: HLC_1.to_string(),
                        starred: false,
                        completed_at: None,
                        archived_at: None,
                    },
                    nodes: Vec::new(),
                },
            )
            .unwrap(),
        )
        .unwrap();
        handle_watch_paths(&vault_path, [&source], &events, &times).unwrap();

        let statuses = events.statuses.lock().unwrap();
        assert_eq!(statuses.len(), 2);
        assert_eq!(statuses[0].vault_path, vault_path);
        assert_eq!(statuses[0].status.quarantined, vec!["recovered.md"]);
        assert!(statuses[1].status.quarantined.is_empty());
        assert_eq!(
            serde_json::to_value(&statuses[1]).unwrap(),
            json!({
                "vaultPath": vault_path,
                "status": {
                    "running": true,
                    "dirtyTopics": 0,
                    "quarantined": [],
                    "lastExportAt": null,
                    "lastMergeAt": statuses[1].status.last_merge_at,
                    "lastError": null
                }
            })
        );
        drop(statuses);
        evict_notes_connection(&vault_path);
    }

    fn is_topic_quarantined(vault_path: &str) -> bool {
        let shared = acquire_notes_connection(vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        connection
            .query_row(
                "SELECT quarantined FROM sync_topics WHERE topic_id = ?1",
                [TOPIC_ID],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .unwrap()
            .unwrap_or(0)
            != 0
    }

    fn dirty_row_count(vault_path: &str) -> i64 {
        let shared = acquire_notes_connection(vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        connection
            .query_row("SELECT COUNT(*) FROM sync_dirty_nodes", [], |row| row.get(0))
            .unwrap()
    }

    // B6: the exact rule-11 counter — three identical failures for one target
    // trip the quarantine; a different error or a success resets the count.
    #[test]
    fn failure_tracker_trips_only_on_three_identical_failures() {
        let mut tracker = FailureTracker::default();
        let target = ExportTarget::Topic(TOPIC_ID.to_string());
        assert_eq!(tracker.record_failure(&target, "boom"), None);
        assert_eq!(tracker.record_failure(&target, "boom"), None);
        // A different error resets the streak.
        assert_eq!(tracker.record_failure(&target, "other"), None);
        assert_eq!(tracker.record_failure(&target, "other"), None);
        assert_eq!(
            tracker.record_failure(&target, "other"),
            Some("other".to_string())
        );
        // A success between failures also resets.
        assert_eq!(tracker.record_failure(&target, "boom"), None);
        tracker.record_success(&target);
        assert_eq!(tracker.record_failure(&target, "boom"), None);
    }

    // B6/rule 11: a topic whose export keeps failing is quarantined after three
    // identical failures, keeps its dirty rows, and resumes once un-quarantined.
    #[test]
    fn three_export_failures_quarantine_the_topic_and_recover_after_release() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault_string(&vault);
        seed_topic(&vault_path);
        {
            let shared = acquire_notes_connection(&vault_path).unwrap();
            let connection = lock_notes_connection(&shared).unwrap();
            connection
                .execute(
                    "INSERT INTO notes_nodes(\
                       id, parent_id, sort_key, title, note, image_offset_utf16, node_kind, \
                       created_at, updated_at, hlc\
                     ) VALUES (?1, ?2, 2048, 'Broken image', '', 0, 'image', \
                               '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z', ?3)",
                    params![BROKEN_CHILD_ID, TOPIC_ID, HLC_1],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1) \
                     ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at",
                    [BROKEN_CHILD_ID],
                )
                .unwrap();
        }
        let times = std::sync::Mutex::new(RuntimeTimes::default());
        let mut schedule = DebounceSchedule::default();
        let mut failures = FailureTracker::default();

        for _ in 0..2 {
            assert!(run_export_cycle(
                &vault_path,
                &mut schedule,
                &mut failures,
                std::time::Duration::ZERO,
                true,
                &times,
            )
            .is_err());
            assert!(!is_topic_quarantined(&vault_path));
            assert!(times.lock().unwrap().last_error.is_none());
        }
        let _ = run_export_cycle(
            &vault_path,
            &mut schedule,
            &mut failures,
            std::time::Duration::ZERO,
            true,
            &times,
        );
        assert!(is_topic_quarantined(&vault_path), "third failure quarantines");
        assert!(times.lock().unwrap().last_error.is_some());
        assert!(dirty_row_count(&vault_path) > 0, "dirty rows retained");

        // Fix the data and release the quarantine — the topic resumes.
        {
            let shared = acquire_notes_connection(&vault_path).unwrap();
            let connection = lock_notes_connection(&shared).unwrap();
            connection
                .execute("DELETE FROM notes_nodes WHERE id = ?1", [BROKEN_CHILD_ID])
                .unwrap();
            connection
                .execute(
                    "UPDATE sync_topics SET quarantined = 0 WHERE topic_id = ?1",
                    [TOPIC_ID],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1) \
                     ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at",
                    [TOPIC_ID],
                )
                .unwrap();
        }
        run_export_cycle(
            &vault_path,
            &mut schedule,
            &mut failures,
            std::time::Duration::ZERO,
            true,
            &times,
        )
        .expect("resume after un-quarantine");
        assert!(vault.path().join("Runtime-topic.11111111.md").is_file());
        evict_notes_connection(&vault_path);
    }

    // B2: a panicking exporter thread is surfaced as running:false with a
    // lastError, and a fresh start heals the dead worker.
    #[test]
    fn exporter_panic_reports_running_false_and_start_recovers() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault_string(&vault);
        seed_topic(&vault_path);
        let state = SyncState::default();
        let events = Arc::new(RecordingEvents::default());
        let runtime_events: Arc<dyn SyncEventEmitter> = events.clone();
        arm_exporter_panic(&vault_path);

        start_sync_with_events(&state, vault_path.clone(), runtime_events).unwrap();

        let mut degraded = None;
        for _ in 0..100 {
            if let Some(status) = events
                .statuses
                .lock()
                .unwrap()
                .iter()
                .find(|status| !status.status.running)
                .cloned()
            {
                degraded = Some(status);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let degraded = degraded.expect("a panicking exporter must emit running:false");
        assert_eq!(degraded.vault_path, vault_path);
        assert!(degraded.status.last_error.is_some());
        assert!(!super::sync_status(&state, vault_path.clone()).unwrap().running);

        let recovered = start_sync(&state, vault_path.clone()).expect("restart heals the worker");
        assert!(recovered.running);
        assert_eq!(active_worker_threads(&state), Some((true, true)));
        stop_sync(&state).unwrap();
        evict_notes_connection(&vault_path);
    }

    // B1: the RunEvent::ExitRequested hook calls stop_sync; that must force a
    // final export of the debounced dirty topic before the window is gone.
    #[test]
    fn stop_sync_forces_a_final_export_like_the_exit_hook() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault_string(&vault);
        seed_topic(&vault_path);
        let state = SyncState::default();
        start_sync(&state, vault_path.clone()).unwrap();
        let file_name = active_topic_filename(&vault_path);
        update_topic(&vault_path, "Exit flushed", HLC_2);

        stop_sync(&state).unwrap();

        assert!(fs::read_to_string(vault.path().join(file_name))
            .unwrap()
            .contains("# Exit flushed"));
        evict_notes_connection(&vault_path);
    }
}
