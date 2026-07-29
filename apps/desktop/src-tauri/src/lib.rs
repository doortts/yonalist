mod image_ipc;
mod startup;

use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use notes_application::{
    BootSnapshot, CloseOutcome, CommandEnvelope, ForestRequest, ForestSnapshot, HistoryRequest,
    ImageAssetPort, MutationReceipt, NotesError, NotesErrorCode, NotesService, SearchPage,
    SearchQuery, ViewportPage, ViewportRequest,
};
use notes_sqlite::{LocalImageAssets, SqliteStorage};
use tauri::{Manager, State};

use crate::startup::StartupGate;

struct DesktopRuntime {
    session_id: String,
    storage: Arc<SqliteStorage>,
    assets: Arc<LocalImageAssets>,
    service: Arc<NotesService<Arc<SqliteStorage>>>,
    initial_boot: Mutex<Option<BootSnapshot>>,
}

struct DesktopState {
    runtime: Arc<StartupGate<DesktopRuntime, NotesError>>,
    closed: AtomicBool,
}

#[tauri::command]
async fn notes_bootstrap(state: State<'_, DesktopState>) -> Result<BootSnapshot, NotesError> {
    let gate = Arc::clone(&state.runtime);
    run_blocking(move || {
        let runtime = gate.wait()?;
        if let Some(snapshot) = runtime
            .initial_boot
            .lock()
            .map_err(|_| internal_error("The initial Notes snapshot lock was poisoned."))?
            .take()
        {
            return Ok(snapshot);
        }
        runtime
            .storage
            .bootstrap(runtime.session_id.clone(), 80)
            .map_err(NotesError::from)
    })
    .await
}

#[tauri::command]
async fn notes_query_viewport(
    state: State<'_, DesktopState>,
    request: ViewportRequest,
) -> Result<ViewportPage, NotesError> {
    let gate = Arc::clone(&state.runtime);
    run_blocking(move || {
        let runtime = gate.wait()?;
        runtime.clear_initial_boot()?;
        runtime
            .storage
            .query_viewport(request)
            .map_err(NotesError::from)
    })
    .await
}

#[tauri::command]
async fn notes_query_forest(
    state: State<'_, DesktopState>,
    request: ForestRequest,
) -> Result<ForestSnapshot, NotesError> {
    let gate = Arc::clone(&state.runtime);
    run_blocking(move || {
        let runtime = gate.wait()?;
        runtime.clear_initial_boot()?;
        runtime
            .storage
            .query_forest(request)
            .map_err(NotesError::from)
    })
    .await
}

#[tauri::command]
async fn notes_execute(
    state: State<'_, DesktopState>,
    envelope: CommandEnvelope,
) -> Result<MutationReceipt, NotesError> {
    let gate = Arc::clone(&state.runtime);
    run_blocking(move || {
        let runtime = gate.wait()?;
        runtime.clear_initial_boot()?;
        runtime.service.execute(envelope)
    })
    .await
}

#[tauri::command]
async fn notes_undo(
    state: State<'_, DesktopState>,
    request: HistoryRequest,
) -> Result<MutationReceipt, NotesError> {
    let gate = Arc::clone(&state.runtime);
    run_blocking(move || {
        let runtime = gate.wait()?;
        runtime.clear_initial_boot()?;
        runtime.service.undo(request)
    })
    .await
}

#[tauri::command]
async fn notes_redo(
    state: State<'_, DesktopState>,
    request: HistoryRequest,
) -> Result<MutationReceipt, NotesError> {
    let gate = Arc::clone(&state.runtime);
    run_blocking(move || {
        let runtime = gate.wait()?;
        runtime.clear_initial_boot()?;
        runtime.service.redo(request)
    })
    .await
}

#[tauri::command]
async fn notes_search(
    state: State<'_, DesktopState>,
    query: SearchQuery,
) -> Result<SearchPage, NotesError> {
    let gate = Arc::clone(&state.runtime);
    run_blocking(move || gate.wait()?.storage.search(query).map_err(NotesError::from)).await
}

#[tauri::command]
async fn notes_close_session(state: State<'_, DesktopState>) -> Result<CloseOutcome, NotesError> {
    let gate = Arc::clone(&state.runtime);
    run_close_attempt(&state.closed, async move {
        run_blocking(move || {
            let runtime = gate.wait()?;
            runtime.storage.optimize().map_err(NotesError::from)?;
            let live_hashes = runtime
                .storage
                .live_image_hashes()
                .map_err(NotesError::from)?;
            runtime
                .assets
                .reconcile(&live_hashes)
                .map_err(NotesError::from)?;
            Ok(())
        })
        .await
    })
    .await
}

fn parse_http_url(value: &str) -> Result<tauri::Url, String> {
    let parsed = tauri::Url::parse(value).map_err(|error| error.to_string())?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        _ => Err("Only absolute http(s) URLs can be opened.".into()),
    }
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = parse_http_url(&url)?;
    open::that(parsed.as_str()).map_err(|error| error.to_string())
}

impl DesktopRuntime {
    fn initialize(data_directory: PathBuf) -> Result<Self, NotesError> {
        std::fs::create_dir_all(&data_directory).map_err(|error| NotesError {
            code: NotesErrorCode::StorageUnavailable,
            message: error.to_string(),
            retryable: true,
        })?;
        let storage = Arc::new(
            SqliteStorage::open(&data_directory.join("notes-v2.sqlite"))
                .map_err(NotesError::from)?,
        );
        let assets = Arc::new(
            LocalImageAssets::open(&data_directory.join("images")).map_err(NotesError::from)?,
        );
        let session_id = uuid::Uuid::new_v4().to_string();
        let initial_boot = storage
            .bootstrap(session_id.clone(), 80)
            .map_err(NotesError::from)?;
        let service = Arc::new(NotesService::new(
            Arc::clone(&storage),
            session_id.clone(),
            initial_boot.revision,
        ));
        Ok(Self {
            session_id,
            storage,
            assets,
            service,
            initial_boot: Mutex::new(Some(initial_boot)),
        })
    }

    fn clear_initial_boot(&self) -> Result<(), NotesError> {
        self.initial_boot
            .lock()
            .map_err(|_| internal_error("The initial Notes snapshot lock was poisoned."))?
            .take();
        Ok(())
    }
}

fn internal_error(message: impl Into<String>) -> NotesError {
    NotesError {
        code: NotesErrorCode::Internal,
        message: message.into(),
        retryable: false,
    }
}

fn select_data_directory(
    default_directory: PathBuf,
    override_directory: Option<std::ffi::OsString>,
) -> PathBuf {
    override_directory
        .map(PathBuf::from)
        .unwrap_or(default_directory)
}

async fn run_close_attempt<F>(closed: &AtomicBool, operation: F) -> Result<CloseOutcome, NotesError>
where
    F: Future<Output = Result<(), NotesError>>,
{
    if closed
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(CloseOutcome::AlreadyClosed);
    }
    match operation.await {
        Ok(()) => Ok(CloseOutcome::Flushed),
        Err(error) => {
            closed.store(false, Ordering::Release);
            Err(error)
        }
    }
}

async fn run_blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, NotesError> + Send + 'static,
) -> Result<T, NotesError> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| NotesError {
            code: NotesErrorCode::Internal,
            message: format!("The Notes worker could not complete: {error}"),
            retryable: false,
        })?
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_single_instance::init(
                |app, _arguments, _working_directory| {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                },
            ))?;
            let data_directory = select_data_directory(
                app.path().app_data_dir()?,
                std::env::var_os("YONALIST_V2_DATA_DIR"),
            );
            let runtime = Arc::new(StartupGate::pending());
            app.manage(DesktopState {
                runtime: Arc::clone(&runtime),
                closed: AtomicBool::new(false),
            });
            std::thread::Builder::new()
                .name("notes-v2-startup".into())
                .spawn(move || runtime.complete(DesktopRuntime::initialize(data_directory)))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            notes_bootstrap,
            notes_query_viewport,
            notes_query_forest,
            notes_execute,
            notes_undo,
            notes_redo,
            notes_search,
            notes_close_session,
            image_ipc::notes_import_image_bytes,
            image_ipc::notes_read_image,
            open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("Yonalist v2 desktop runtime failed");
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;

    use super::{internal_error, parse_http_url, run_close_attempt, select_data_directory};
    use notes_application::{CommandEnvelope, IpcNotesCommand};

    #[test]
    fn tauri_command_envelope_accepts_the_generated_typescript_wire_shape() {
        let json = serde_json::json!({
            "sessionId": "session-1",
            "requestId": "request-1",
            "baseRevision": 7,
            "historyGroup": "typing:node-1",
            "command": {
                "kind": "createNode",
                "id": "node-2",
                "parent_id": "page-1",
                "before_id": null,
                "text": "New thought"
            }
        });

        let envelope: CommandEnvelope =
            serde_json::from_value(json).expect("generated TypeScript JSON must deserialize");

        assert_eq!(envelope.session_id, "session-1");
        assert_eq!(envelope.request_id, "request-1");
        assert_eq!(envelope.base_revision, 7);
        assert_eq!(envelope.history_group.as_deref(), Some("typing:node-1"));
        assert_eq!(
            envelope.command,
            IpcNotesCommand::CreateNode {
                id: "node-2".into(),
                parent_id: "page-1".into(),
                before_id: None,
                text: "New thought".into(),
            }
        );

        let round_trip = serde_json::to_value(envelope).expect("envelope must serialize");
        assert_eq!(round_trip["baseRevision"], 7);
        assert_eq!(round_trip["command"]["kind"], "createNode");
        assert_eq!(round_trip["command"]["parent_id"], "page-1");
        assert!(round_trip.get("base_revision").is_none());
    }

    #[test]
    fn explicit_data_directory_override_supports_isolated_packaged_process_tests() {
        let selected = select_data_directory(
            PathBuf::from("default-data"),
            Some(OsString::from("isolated-data")),
        );

        assert_eq!(selected, PathBuf::from("isolated-data"));
    }

    #[test]
    fn external_links_accept_only_absolute_http_and_https_urls() {
        assert!(parse_http_url("https://example.com/path").is_ok());
        assert!(parse_http_url("http://localhost:1421/preview").is_ok());
        for unsafe_url in [
            "javascript:alert(1)",
            "data:text/plain,hello",
            "mailto:test@example.com",
            "//example.com/path",
            "example.com",
        ] {
            assert!(parse_http_url(unsafe_url).is_err(), "{unsafe_url}");
        }
    }

    #[test]
    fn failed_close_maintenance_can_be_retried_before_marking_the_session_closed() {
        let closed = AtomicBool::new(false);
        let first = tauri::async_runtime::block_on(run_close_attempt(&closed, async {
            Err(internal_error("optimize failed"))
        }));
        assert!(first.is_err());

        let retry =
            tauri::async_runtime::block_on(run_close_attempt(&closed, async { Ok(()) })).unwrap();
        assert_eq!(retry, notes_application::CloseOutcome::Flushed);

        let after_close =
            tauri::async_runtime::block_on(run_close_attempt(&closed, async { Ok(()) })).unwrap();
        assert_eq!(after_close, notes_application::CloseOutcome::AlreadyClosed);
    }
}
