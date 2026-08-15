mod export_ipc;
mod image_file_actions;
mod image_ipc;
mod image_replace_ipc;
mod startup;
mod sync_settings;

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use notes_application::{
    BootSnapshot, CloseOutcome, CommandEnvelope, ForestRequest, ForestSnapshot, HistoryRequest,
    ImageAssetPort, MutationReceipt, NotesError, NotesErrorCode, NotesService, SearchPage,
    SearchQuery, UnusedAssetsReport, ViewportPage, ViewportRequest,
};
use notes_export::{NativeExportPublisher, NativeExportRenderer};
use notes_sqlite::{LocalImageAssets, SqliteStorage};
use tauri::{Manager, State};

use crate::startup::StartupGate;

struct DesktopRuntime {
    session_id: String,
    storage: Arc<SqliteStorage>,
    assets: Arc<LocalImageAssets>,
    data_directory: PathBuf,
    original_directory: PathBuf,
    service: Arc<NotesService<Arc<SqliteStorage>>>,
    export_renderer: Arc<NativeExportRenderer>,
    export_publisher: Arc<NativeExportPublisher>,
    initial_boot: Mutex<Option<BootSnapshot>>,
}

struct DesktopState {
    runtime: Arc<StartupGate<DesktopRuntime, NotesError>>,
    /// Held here rather than inside the runtime because the vault commands
    /// answer before the worker is up: the first-run screen asks where the
    /// vault is while the database is still opening.
    data_directory: PathBuf,
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
        // A pasted image references an existing asset, so the command path needs
        // the store to reject a hash that is no longer there.
        runtime
            .service
            .execute_with_assets(envelope, runtime.assets.as_ref())
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
            if runtime.original_directory.exists() {
                std::fs::remove_dir_all(&runtime.original_directory).map_err(|error| {
                    NotesError {
                        code: NotesErrorCode::StorageUnavailable,
                        message: error.to_string(),
                        retryable: true,
                    }
                })?;
            }
            Ok(())
        })
        .await
    })
    .await
}

const DELETE_DATA_MARKER: &str = "delete-notes-data-on-start";

#[tauri::command]
async fn notes_unused_assets(
    state: State<'_, DesktopState>,
    purge: bool,
) -> Result<UnusedAssetsReport, NotesError> {
    let gate = Arc::clone(&state.runtime);
    run_blocking(move || {
        let runtime = gate.wait()?;
        let live_hashes = runtime
            .storage
            .live_image_hashes()
            .map_err(NotesError::from)?;
        let images = runtime.data_directory.join("images");
        let mut count: u32 = 0;
        let mut total_bytes: u64 = 0;
        if images.is_dir() {
            let entries = std::fs::read_dir(&images).map_err(|error| NotesError {
                code: NotesErrorCode::StorageUnavailable,
                message: error.to_string(),
                retryable: true,
            })?;
            for entry in entries {
                let entry = entry.map_err(|error| NotesError {
                    code: NotesErrorCode::StorageUnavailable,
                    message: error.to_string(),
                    retryable: true,
                })?;
                let metadata =
                    std::fs::symlink_metadata(entry.path()).map_err(|error| NotesError {
                        code: NotesErrorCode::StorageUnavailable,
                        message: error.to_string(),
                        retryable: true,
                    })?;
                if !metadata.is_file() {
                    continue;
                }
                let name = entry.file_name();
                let name = name.to_string_lossy();
                let hash = name.split_once('.').map(|(hash, _)| hash);
                if hash.is_none_or(|hash| !live_hashes.contains(hash)) {
                    count += 1;
                    total_bytes = total_bytes.saturating_add(metadata.len());
                }
            }
        }
        if purge && count > 0 {
            runtime
                .assets
                .reconcile(&live_hashes)
                .map_err(NotesError::from)?;
        }
        Ok(UnusedAssetsReport {
            count,
            total_bytes,
            purged: purge,
        })
    })
    .await
}

#[tauri::command]
async fn notes_sync_vault_get(
    state: State<'_, DesktopState>,
) -> Result<Option<String>, NotesError> {
    Ok(sync_settings::read_vault_path(&state.data_directory)
        .map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn notes_sync_vault_set(
    state: State<'_, DesktopState>,
    path: String,
) -> Result<(), NotesError> {
    sync_settings::set_vault_path(&state.data_directory, Path::new(&path)).map_err(|message| {
        NotesError {
            code: NotesErrorCode::InvalidCommand,
            message,
            retryable: false,
        }
    })
}

#[tauri::command]
async fn notes_delete_all_data(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<(), NotesError> {
    let gate = Arc::clone(&state.runtime);
    let marker = run_blocking(move || {
        let runtime = gate.wait()?;
        let marker = runtime.data_directory.join(DELETE_DATA_MARKER);
        std::fs::write(&marker, b"1").map_err(|error| NotesError {
            code: NotesErrorCode::StorageUnavailable,
            message: error.to_string(),
            retryable: true,
        })?;
        Ok(marker)
    })
    .await?;
    let _ = marker;
    app.restart();
}

fn apply_pending_data_deletion(data_directory: &Path) -> std::io::Result<()> {
    let marker = data_directory.join(DELETE_DATA_MARKER);
    if !marker.exists() {
        return Ok(());
    }
    for database_file in [
        "notes-v2.sqlite",
        "notes-v2.sqlite-wal",
        "notes-v2.sqlite-shm",
    ] {
        let path = data_directory.join(database_file);
        if path.exists() {
            std::fs::remove_file(path)?;
        }
    }
    // The vault holds the user's documents and is not this app's to delete, so
    // the reset forgets where it is and stops there. Leaving the path instead
    // would re-adopt the folder on the next boot and make "delete all data"
    // mean nothing.
    sync_settings::clear_vault_path(data_directory).map_err(std::io::Error::other)?;
    for directory in ["images", "original-views"] {
        let path = data_directory.join(directory);
        if path.exists() {
            std::fs::remove_dir_all(path)?;
        }
    }
    std::fs::remove_file(marker)
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

/// Logical inset `(x, y)` for the macOS window controls ("traffic lights"),
/// chosen from the detected macOS major version.
///
/// macOS Tahoe (major 26) reworked window chrome: the top-left corner uses a
/// much larger radius drawn concentric with the red close button, and the
/// controls sit slightly higher in the bar, so the older `(20, 15)` inset
/// leaves them crammed into the corner there. Both values put the controls on
/// the 42px titlebar's center line, which is what `.pane-toggle` glyphs line
/// up against. Kept free of `cfg(target_os)` so it stays unit-testable on every
/// platform (only the caller is macOS-gated).
fn traffic_light_inset(macos_major: Option<u32>) -> (f64, f64) {
    match macos_major {
        Some(major) if major >= 26 => (22.0, 20.0),
        _ => (20.0, 15.0),
    }
}

/// Detected macOS major version via `NSProcessInfo`, e.g. `26` on Tahoe, `15`
/// on Sequoia. `None` if the value does not fit a `u32` (never expected).
#[cfg(target_os = "macos")]
fn macos_major_version() -> Option<u32> {
    use objc2_foundation::NSProcessInfo;
    let version = NSProcessInfo::processInfo().operatingSystemVersion();
    u32::try_from(version.majorVersion).ok()
}

/// Creates the main window in Rust rather than `tauri.conf.json` so the macOS
/// traffic-light inset can be picked at launch from the OS version: the
/// builder's `traffic_light_position` is the only supported hook (there is no
/// runtime setter on `WebviewWindow`), and wry re-applies it across resize and
/// fullscreen. The window keeps its decorations so macOS still draws the
/// rounded corners, the shadow and the controls themselves; `Overlay` is what
/// lets the webview paint under the titlebar the way an undecorated window did.
fn build_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    #[allow(unused_mut)]
    let mut builder =
        tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
            .title("Yonalist")
            .inner_size(1200.0, 760.0)
            .min_inner_size(840.0, 560.0)
            .decorations(true);

    // Overlay title bar, hidden title and traffic-light placement are macOS-only
    // concepts, so they stay off every other platform.
    #[cfg(target_os = "macos")]
    {
        let (x, y) = traffic_light_inset(macos_major_version());
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(x, y));
    }

    builder.build()?;
    Ok(())
}

/// The main window hides its title bar behind the app's own chrome, so there is
/// no native menu bar and macOS gives a WKWebView no built-in inspector
/// shortcut. The keyboard shortcut in the frontend is the only way in; this is
/// what it calls. Answers the state the webview ended up in.
#[tauri::command]
async fn notes_toggle_devtools(webview: tauri::WebviewWindow) -> bool {
    #[cfg(any(debug_assertions, feature = "devtools"))]
    let open = {
        let opening = !webview.is_devtools_open();
        if opening {
            webview.open_devtools();
        } else {
            webview.close_devtools();
        }
        opening
    };
    // A release build carries no inspector unless it opted into the `devtools`
    // feature, so there is nothing to toggle and the shortcut does nothing.
    #[cfg(not(any(debug_assertions, feature = "devtools")))]
    let open = {
        let _ = webview;
        false
    };
    open
}

impl DesktopRuntime {
    fn initialize(data_directory: PathBuf, font_path: PathBuf) -> Result<Self, NotesError> {
        std::fs::create_dir_all(&data_directory).map_err(|error| NotesError {
            code: NotesErrorCode::StorageUnavailable,
            message: error.to_string(),
            retryable: true,
        })?;
        apply_pending_data_deletion(&data_directory).map_err(|error| NotesError {
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
        let original_directory = data_directory.join("original-views").join(&session_id);
        let export_renderer = Arc::new(NativeExportRenderer::new(font_path));
        let export_publisher = Arc::new(NativeExportPublisher::new(vec![
            data_directory.clone(),
            data_directory.join("images"),
            original_directory.clone(),
        ]));
        Ok(Self {
            session_id,
            storage,
            assets,
            data_directory,
            original_directory,
            service,
            export_renderer,
            export_publisher,
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
        .plugin(tauri_plugin_dialog::init())
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
            build_main_window(app.handle())?;
            let data_directory = select_data_directory(
                app.path().app_data_dir()?,
                std::env::var_os("YONALIST_V2_DATA_DIR"),
            );
            let font_path = app
                .path()
                .resource_dir()?
                .join("resources")
                .join("NanumGothic-Regular.ttf");
            let runtime = Arc::new(StartupGate::pending());
            app.manage(DesktopState {
                runtime: Arc::clone(&runtime),
                data_directory: data_directory.clone(),
                closed: AtomicBool::new(false),
            });
            std::thread::Builder::new()
                .name("notes-v2-startup".into())
                .spawn(move || {
                    runtime.complete(DesktopRuntime::initialize(data_directory, font_path))
                })?;
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
            notes_unused_assets,
            notes_delete_all_data,
            notes_sync_vault_get,
            notes_sync_vault_set,
            export_ipc::notes_export,
            image_ipc::notes_import_image_bytes,
            image_ipc::notes_import_image_paths,
            image_ipc::notes_read_image,
            image_replace_ipc::notes_replace_image_bytes,
            image_replace_ipc::notes_replace_image_path,
            image_file_actions::notes_view_image_original,
            image_file_actions::notes_download_image,
            notes_toggle_devtools,
            open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("Yonalist v2 desktop runtime failed");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_data_reset_clears_the_stored_vault_path() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let data = directory.path().join("app-data");
        let vault = directory.path().join("Notes");
        std::fs::create_dir_all(&data).expect("data");
        std::fs::create_dir_all(&vault).expect("vault");
        std::fs::write(vault.join("README.md"), b"# Home\n").expect("document");
        sync_settings::set_vault_path(&data, &vault).expect("set");
        std::fs::write(data.join(DELETE_DATA_MARKER), b"1").expect("marker");

        apply_pending_data_deletion(&data).expect("reset");

        assert_eq!(
            sync_settings::read_vault_path(&data),
            None,
            "clearing the data returns the app to first run"
        );
        assert!(
            vault.join("README.md").exists(),
            "and leaves the documents in the folder alone"
        );
    }

    use std::ffi::OsString;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;

    use super::{
        internal_error, parse_http_url, run_close_attempt, select_data_directory,
        traffic_light_inset,
    };
    use notes_application::{CommandEnvelope, IpcImportNode, IpcMarkerKind, IpcNotesCommand};

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
    fn an_import_payload_deserializes_with_and_without_the_rich_paste_fields() {
        let import = |node: serde_json::Value| {
            serde_json::from_value::<IpcNotesCommand>(serde_json::json!({
                "kind": "importNodes",
                "parent_id": "page-1",
                "before_id": null,
                "nodes": [node]
            }))
            .expect("generated TypeScript JSON must deserialize")
        };

        // The three-field shape a plain text paste still sends.
        let plain = import(serde_json::json!({
            "id": "node-2",
            "parentId": "page-1",
            "text": "Buy milk"
        }));
        let IpcNotesCommand::ImportNodes { nodes, .. } = plain else {
            panic!("import must deserialize as an import command");
        };
        assert_eq!(
            nodes,
            vec![IpcImportNode {
                id: "node-2".into(),
                parent_id: "page-1".into(),
                text: "Buy milk".into(),
                ..IpcImportNode::default()
            }]
        );

        let rich = import(serde_json::json!({
            "id": "node-3",
            "parentId": "page-1",
            "text": "sample.png",
            "note": "Two litres",
            "marker": "todo",
            "completed": true,
            "image": {
                "contentHash": "a".repeat(64),
                "originalName": "sample.png",
                "mimeType": "image/png",
                "byteLength": 3,
                "pixelWidth": 1,
                "pixelHeight": 1,
                "displayWidth": 320
            }
        }));
        let IpcNotesCommand::ImportNodes { nodes, .. } = rich else {
            panic!("import must deserialize as an import command");
        };
        assert_eq!(nodes[0].note.as_deref(), Some("Two litres"));
        assert_eq!(nodes[0].marker, Some(IpcMarkerKind::Todo));
        assert_eq!(nodes[0].completed, Some(true));
        assert_eq!(
            nodes[0].image.as_ref().map(|image| image.byte_length),
            Some(3)
        );
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

    #[test]
    fn traffic_light_inset_follows_the_macos_version() {
        // Tahoe and anything after it take the roomier inset; every earlier
        // release -- and an undetectable version -- keeps the original.
        assert_eq!(traffic_light_inset(Some(26)), (22.0, 20.0));
        assert_eq!(traffic_light_inset(Some(27)), (22.0, 20.0));
        assert_eq!(traffic_light_inset(Some(15)), (20.0, 15.0));
        assert_eq!(traffic_light_inset(None), (20.0, 15.0));
    }
}
