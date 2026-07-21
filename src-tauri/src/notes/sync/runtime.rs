use crate::notes::connection::{acquire_notes_connection, lock_notes_connection};
use crate::notes::error::{NotesError, NotesErrorCode};
use crate::notes::repository::vault_key;
use crate::notes::sync::bootstrap::{flush_pending, reconcile_startup};
use crate::notes::sync::exporter::{
    load_pending_exports, publish_pending_exports, DebounceSchedule,
};
use serde::Serialize;
use std::sync::{mpsc, Arc, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncStatus {
    pub(crate) running: bool,
    pub(crate) dirty_topics: u32,
    pub(crate) quarantined: Vec<String>,
    pub(crate) last_export_at: Option<String>,
    pub(crate) last_merge_at: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct RuntimeTimes {
    last_export_at: Option<String>,
    last_merge_at: Option<String>,
}

enum RuntimeControl {
    Flush(mpsc::Sender<Result<(), String>>),
    Stop(mpsc::Sender<Result<(), String>>),
}

pub(crate) struct SyncRuntime {
    vault_path: String,
    vault_key: String,
    control: mpsc::Sender<RuntimeControl>,
    worker: Option<JoinHandle<()>>,
    times: Arc<Mutex<RuntimeTimes>>,
}

impl SyncRuntime {
    fn spawn(vault_path: String, times: RuntimeTimes) -> Result<Self, String> {
        let (control, receiver) = mpsc::channel();
        let shared_times = Arc::new(Mutex::new(times));
        let worker_times = Arc::clone(&shared_times);
        let worker_vault = vault_path.clone();
        let worker = thread::Builder::new()
            .name("notes-sync-exporter".to_string())
            .spawn(move || exporter_loop(worker_vault, receiver, worker_times))
            .map_err(|error| format!("Could not start the Notes exporter: {error}"))?;
        Ok(Self {
            vault_key: vault_key(&vault_path),
            vault_path,
            control,
            worker: Some(worker),
            times: shared_times,
        })
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
        let flush_result = if self.worker.is_some() {
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
        if let Some(worker) = self.worker.take() {
            worker
                .join()
                .map_err(|_| "The Notes exporter thread panicked.".to_string())?;
        }
        flush_result
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
    let requested_key = vault_key(&vault_path);
    let mut runtime_slot = lock_state(state);
    if runtime_slot
        .as_ref()
        .is_some_and(|runtime| runtime.vault_key == requested_key)
    {
        return status_for_runtime(runtime_slot.as_ref(), &vault_path);
    }
    if let Some(mut previous) = runtime_slot.take() {
        previous.stop()?;
    }
    let bootstrap = reconcile_startup(&vault_path)?;
    if !bootstrap.errors.is_empty() {
        eprintln!(
            "Notes sync startup completed with retryable target failures: {}",
            bootstrap.errors.join("; ")
        );
    }
    let runtime = SyncRuntime::spawn(
        vault_path.clone(),
        RuntimeTimes {
            last_export_at: bootstrap.last_export_at,
            last_merge_at: bootstrap.last_merge_at,
        },
    )?;
    *runtime_slot = Some(runtime);
    status_for_runtime(runtime_slot.as_ref(), &vault_path)
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
        running: running_runtime.is_some(),
        dirty_topics,
        quarantined,
        last_export_at: times.last_export_at,
        last_merge_at: times.last_merge_at,
    })
}

#[cfg(test)]
pub(crate) fn active_vault_path(state: &SyncState) -> Option<String> {
    lock_state(state)
        .as_ref()
        .map(|runtime| runtime.vault_path.clone())
}

fn exporter_loop(
    vault_path: String,
    receiver: mpsc::Receiver<RuntimeControl>,
    times: Arc<Mutex<RuntimeTimes>>,
) {
    let started_at = Instant::now();
    let mut schedule = DebounceSchedule::default();
    loop {
        // ponytail: 1s poll, 이벤트 채널로 교체 가능
        let (force, reply, should_stop) = match receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(RuntimeControl::Flush(reply)) => (true, Some(reply), false),
            Ok(RuntimeControl::Stop(reply)) => (true, Some(reply), true),
            Err(mpsc::RecvTimeoutError::Timeout) => (false, None, false),
            Err(mpsc::RecvTimeoutError::Disconnected) => (true, None, true),
        };
        let result = run_export_cycle(
            &vault_path,
            &mut schedule,
            started_at.elapsed(),
            force,
            &times,
        );
        if let Some(reply) = reply {
            let _ = reply.send(result);
        } else if let Err(error) = result {
            eprintln!("Notes exporter cycle failed: {error}");
        }
        if should_stop {
            break;
        }
    }
}

fn run_export_cycle(
    vault_path: &str,
    schedule: &mut DebounceSchedule,
    now: Duration,
    force: bool,
    times: &Mutex<RuntimeTimes>,
) -> Result<(), String> {
    let shared = acquire_notes_connection(vault_path)?;
    let mut connection = lock_notes_connection(&shared)?;
    let pending = load_pending_exports(&connection)?;
    let observed = pending
        .iter()
        .map(|(target, pending)| (target.clone(), pending.fingerprint.clone()))
        .collect();
    let due = schedule.due(now, observed, force);
    if due.is_empty() {
        return Ok(());
    }
    let selected = due
        .iter()
        .filter_map(|target| pending.get(target))
        .collect::<Vec<_>>();
    let outcome = publish_pending_exports(
        &mut connection,
        &crate::expand_vault_path(vault_path),
        selected,
    );
    for target in &outcome.succeeded {
        schedule.complete(target);
    }
    if outcome.exported != 0 {
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
    _app: tauri::AppHandle,
    state: tauri::State<'_, SyncState>,
    vault_path: String,
) -> Result<SyncStatus, NotesError> {
    let state = state.inner().clone();
    run_blocking(move || start_sync(&state, vault_path)).await
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
    use super::{active_vault_path, flush_sync, start_sync, stop_sync, SyncState};
    use crate::notes::connection::{
        acquire_notes_connection, evict_notes_connection, lock_notes_connection,
    };
    use rusqlite::params;
    use std::fs;

    const TOPIC_ID: &str = "11111111-1111-4111-8111-111111111111";
    const BROKEN_CHILD_ID: &str = "22222222-2222-4222-8222-222222222222";
    const HEALTHY_TOPIC_ID: &str = "33333333-3333-4333-8333-333333333333";
    const HLC_1: &str = "000000001-00-a3f2";
    const HLC_2: &str = "000000002-00-a3f2";
    const HLC_3: &str = "000000003-00-a3f2";

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
        assert!(start_sync(&state, second_path.clone()).unwrap().running);
        assert_eq!(
            active_vault_path(&state).as_deref(),
            Some(second_path.as_str())
        );
        stop_sync(&state).unwrap();
        stop_sync(&state).unwrap();
        assert_eq!(active_vault_path(&state), None);
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
}
