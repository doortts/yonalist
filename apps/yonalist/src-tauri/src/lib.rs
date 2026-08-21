mod export_ipc;
mod image_file_actions;
mod image_ipc;
mod image_replace_ipc;
mod startup;
mod sync_runtime;
mod sync_settings;
mod sync_status;
mod vault_watch;

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use notes_application::{
    BootSnapshot, CloseOutcome, CommandEnvelope, ForestRequest, ForestSnapshot, HistoryRequest,
    ImageAssetPort, MutationReceipt, NotesError, NotesErrorCode, NotesService, PageSummary,
    SearchPage, SearchQuery, SyncAttachment, SyncChanged, SyncConflict, SyncStatus,
    SyncVaultFolderState, UnusedAssetsReport, VaultRebuildReport, ViewportPage, ViewportRequest,
};
use notes_export::{NativeExportPublisher, NativeExportRenderer};
use notes_sqlite::{LocalImageAssets, SqliteStorage};
use tauri::{Emitter, Manager, State};

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
    /// What sync cannot do right now. Asked for by the window rather than
    /// pushed to it, so an answer is there for whoever asks late.
    status: Arc<sync_status::SyncErrors>,
    /// Held rather than dropped: the watch ends when this does. Absent until
    /// the user has picked a folder, and replaced when they pick another.
    watch: Mutex<Option<vault_watch::VaultWatch>>,
    /// Its own `Arc` on the storage is what keeps the exporter's last write
    /// safe, not this field's place in the struct: fields drop in declaration
    /// order, so being last means dropping after `storage`, not before.
    sync: sync_runtime::SyncRuntime,
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
        let cached = runtime
            .initial_boot
            .lock()
            .map_err(|_| internal_error("The initial Notes snapshot lock was poisoned."))?
            .take();
        let live_revision = runtime.storage.revision().map_err(NotesError::from)?;
        if let Some(snapshot) = current_boot(cached, live_revision) {
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
async fn notes_pages(state: State<'_, DesktopState>) -> Result<Vec<PageSummary>, NotesError> {
    let gate = Arc::clone(&state.runtime);
    run_blocking(move || {
        let runtime = gate.wait()?;
        runtime.storage.pages().map_err(NotesError::from)
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
        runtime.changed(
            runtime
                .service
                .execute_with_assets(envelope, runtime.assets.as_ref()),
        )
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
        runtime.changed(runtime.service.undo(request))
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
        runtime.changed(runtime.service.redo(request))
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
async fn notes_close_session(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<CloseOutcome, NotesError> {
    let gate = Arc::clone(&state.runtime);
    run_close_attempt(&state.closed, async move {
        run_blocking(move || {
            let runtime = gate.wait()?;
            // Before anything else this does: quitting with edits still only in
            // the database is how notes go missing.
            if let Err(reason) = runtime.sync.flush() {
                // The one write the user waits for. If it could not happen,
                // the badge says so rather than the app closing quietly.
                if runtime.status.set_write(Some(reason.clone())) {
                    say_status_changed(&app);
                }
                return Err(internal_error(reason));
            }
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
async fn notes_sync_conflicts(
    state: State<'_, DesktopState>,
    limit: u32,
) -> Result<Vec<SyncConflict>, NotesError> {
    let gate = Arc::clone(&state.runtime);
    run_blocking(move || {
        gate.wait()?
            .storage
            .sync_conflicts(limit)
            .map_err(NotesError::from)
    })
    .await
}

#[tauri::command]
async fn notes_sync_restore_conflict(
    state: State<'_, DesktopState>,
    seq: i64,
) -> Result<(), NotesError> {
    let gate = Arc::clone(&state.runtime);
    run_blocking(move || {
        let runtime = gate.wait()?;
        let (node_id, text) = runtime
            .storage
            .conflict_loser(seq)
            .map_err(NotesError::from)?
            .ok_or_else(|| NotesError {
                code: NotesErrorCode::InvalidCommand,
                message: "That note is no longer in the list.".to_owned(),
                retryable: false,
            })?;
        // Through the service, so this session learns the revision it moved —
        // a bypass would leave every later edit failing until a restart.
        runtime.changed(runtime.service.restore_conflict(&node_id, &text))?;
        Ok(())
    })
    .await
}

/// One recorded defeat, let go of. The list is a record rather than a queue,
/// so being done with an entry is a thing the user has to be able to say —
/// otherwise the only way to clear a row is to put its text back.
#[tauri::command]
async fn notes_sync_forget_conflict(
    state: State<'_, DesktopState>,
    seq: i64,
) -> Result<bool, NotesError> {
    let gate = Arc::clone(&state.runtime);
    run_blocking(move || {
        gate.wait()?
            .storage
            .forget_conflict(seq)
            .map_err(NotesError::from)
    })
    .await
}

/// What sync cannot do right now: the files it could not read, and whether
/// writing or watching the folder is failing.
#[tauri::command]
async fn notes_sync_status(state: State<'_, DesktopState>) -> Result<SyncStatus, NotesError> {
    let gate = Arc::clone(&state.runtime);
    run_blocking(move || {
        let runtime = gate.wait()?;
        Ok(SyncStatus {
            refused: runtime.storage.refused_files().map_err(NotesError::from)?,
            write_error: runtime.status.write_error(),
            watch_error: runtime.status.watch_error(),
        })
    })
    .await
}

/// Every attachment this vault holds, biggest first.
#[tauri::command]
async fn notes_sync_attachments(
    state: State<'_, DesktopState>,
    limit: u32,
) -> Result<Vec<SyncAttachment>, NotesError> {
    let gate = Arc::clone(&state.runtime);
    run_blocking(move || {
        gate.wait()?
            .storage
            .attachments(limit)
            .map_err(NotesError::from)
    })
    .await
}

/// Removes an attachment nothing points at. Answers `false` when something
/// started pointing at it again since the list was drawn — the count is taken
/// with the removal rather than from the screen.
#[tauri::command]
async fn notes_sync_delete_attachment(
    state: State<'_, DesktopState>,
    content_hash: String,
) -> Result<bool, NotesError> {
    let gate = Arc::clone(&state.runtime);
    let vault = sync_settings::read_vault_path(&state.data_directory);
    run_blocking(move || {
        gate.wait()?
            .storage
            .delete_attachment(&content_hash, vault.as_deref())
            .map_err(NotesError::from)
    })
    .await
}

/// Write what is waiting now instead of when the window closes. What the user
/// reaches for when they want to see their notes in the folder this second.
#[tauri::command]
async fn notes_sync_flush(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<(), NotesError> {
    let gate = Arc::clone(&state.runtime);
    run_blocking(move || {
        let runtime = gate.wait()?;
        match runtime.sync.flush() {
            Ok(()) => Ok(()),
            Err(reason) => {
                // The one write the user waits for. If it could not happen,
                // the badge says so as well as this answer.
                if runtime.status.set_write(Some(reason.clone())) {
                    say_status_changed(&app);
                }
                Err(internal_error(reason))
            }
        }
    })
    .await
}

/// Throws this device's cached notes away and builds them again from the
/// folder's files. The folder is the truth and the database is a cache of it,
/// which is the whole of why this is safe to offer.
///
/// The order matters at every step. What is waiting goes out first, so an edit
/// the folder has never been told about is in the folder before the folder is
/// read as the truth; the storage refuses the whole thing if anything is still
/// waiting after that, before it clears a single row. Then the session is told
/// the new revision — a window redrawn against rows this session cannot name
/// would have its next keystroke refused — and the exporter is woken, because a
/// merge can decide a file needs rewriting and nothing else asks it to.
#[tauri::command]
async fn notes_rebuild_from_vault(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<VaultRebuildReport, NotesError> {
    // Without a folder there is nothing to rebuild from, so clearing the
    // database would simply be losing everything. The button is disabled for
    // the same reason; this is the answer for anyone who gets past it.
    let Some(vault) = sync_settings::read_vault_path(&state.data_directory) else {
        return Err(NotesError {
            code: NotesErrorCode::InvalidDestination,
            message: "Choose a sync folder first: a rebuild reads your notes back \
                      out of that folder, and there is nothing to read without one."
                .to_owned(),
            retryable: false,
        });
    };
    let gate = Arc::clone(&state.runtime);
    run_blocking(move || {
        let runtime = gate.wait()?;
        // Before anything is read, and before anything is cleared: an edit that
        // has not reached the folder is not in the folder, and the folder is
        // about to become the only truth.
        if let Err(reason) = runtime.sync.flush() {
            if runtime.status.set_write(Some(reason.clone())) {
                say_status_changed(&app);
            }
            return Err(internal_error(reason));
        }
        let report = runtime
            .storage
            .rebuild_from_vault(&vault)
            .map_err(NotesError::from)?;
        let revision = runtime.storage.revision().map_err(NotesError::from)?;
        runtime.service.reset_session(revision);
        runtime.changed(Ok(rebuild_report(report)))
    })
    .await
}

/// The two numbers the window shows. `merged` is deliberately not one of them:
/// it counts documents that changed a row, so a folder the database already
/// agrees with would report nothing where every file was read.
fn rebuild_report(report: notes_sqlite::ReindexReport) -> VaultRebuildReport {
    VaultRebuildReport {
        documents: report.read as u32,
        unreadable: report.skipped as u32,
    }
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
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    path: String,
) -> Result<SyncVaultFolderState, NotesError> {
    let folder = sync_settings::set_vault_path(&state.data_directory, Path::new(&path))
        .map_err(NotesError::from)?;
    // The folder is only watched once it is known, and this is where it
    // becomes known — on first run there was nothing to watch at startup.
    let gate = Arc::clone(&state.runtime);
    run_blocking(move || {
        let runtime = gate.wait()?;
        runtime.watch_vault(&app);
        // Where these notes live is the one question the first-run card asks,
        // and this is the answer. Recorded here rather than by the guide: a
        // device joining a folder that already holds notes is given no guide,
        // so leaving the mark to the guide left that device asked again on
        // every launch.
        runtime
            .storage
            .mark_onboarding_answered()
            .map_err(NotesError::from)
    })
    .await?;
    Ok(folder)
}

/// Whether the user has yet to say where these notes live. One value in the
/// database and nothing else — not the recorded folder, and not the window's own
/// storage, which survives every reset this app can do.
#[tauri::command]
async fn notes_onboarding_first_run(state: State<'_, DesktopState>) -> Result<bool, NotesError> {
    let gate = Arc::clone(&state.runtime);
    run_blocking(move || {
        gate.wait()?
            .storage
            .onboarding_first_run()
            .map_err(NotesError::from)
    })
    .await
}

/// The guide notes, written once the user has settled where these notes live.
/// Not part of opening the database: a device joining a folder that already
/// holds notes must not restate every line of the guide as its own, newer than
/// anything the other device has said. Answering twice is harmless — the guide
/// is written once per database and never over notes that are already there.
#[tauri::command]
async fn notes_onboarding_write_guide(state: State<'_, DesktopState>) -> Result<(), NotesError> {
    let gate = Arc::clone(&state.runtime);
    run_blocking(move || {
        gate.wait()?.storage.seed_onboarding()?;
        Ok(())
    })
    .await
}

#[tauri::command]
async fn notes_delete_all_data(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<(), NotesError> {
    // The state's own copy of the directory, not the runtime's: the reset is
    // what a failed startup leaves the user, and asking the gate for a runtime
    // would hand back that startup's error instead of clearing it.
    let data_directory = state.data_directory.clone();
    run_blocking(move || request_data_deletion(&data_directory)).await?;
    app.restart();
}

/// Records the request; the deletion itself happens on the next start, before
/// anything opens the database.
fn request_data_deletion(data_directory: &Path) -> Result<(), NotesError> {
    // Nothing is waited on before this runs, so the directory the startup
    // thread makes may not be there yet.
    std::fs::create_dir_all(data_directory)
        .and_then(|()| std::fs::write(data_directory.join(DELETE_DATA_MARKER), b"1"))
        .map_err(|error| NotesError {
            code: NotesErrorCode::StorageUnavailable,
            message: error.to_string(),
            retryable: true,
        })
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
            .title("Yonalist");

    // A window's size and its borders are desktop questions; on a phone the
    // webview is the screen. The sizes are not merely pointless there, they are
    // harmful: iOS lays the page out at whatever width it is given, so a
    // desktop 1200 leaves a phone rendering a 1200 point page and showing the
    // left third of it.
    #[cfg(desktop)]
    {
        builder = builder
            .inner_size(1200.0, 760.0)
            .min_inner_size(840.0, 560.0)
            .decorations(true);
    }

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
    fn initialize(
        data_directory: PathBuf,
        font_path: PathBuf,
        window: tauri::AppHandle,
    ) -> Result<Self, NotesError> {
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
        // Not fatal, and deliberately not reported: an unnamed device shows as
        // the four hex characters its stamps already carry, which is a worse
        // label but not a broken one.
        if let Some(name) = computer_name() {
            let _ = storage.set_device_name(&name);
        }
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
        let status = Arc::new(sync_status::SyncErrors::default());
        let exporter = {
            let storage = Arc::clone(&storage);
            let data_directory = data_directory.clone();
            let store_root = data_directory.join("images");
            let status = Arc::clone(&status);
            let window = window.clone();
            move || {
                // Read every time: the vault can be picked, or changed, long
                // after this thread started.
                let Some(vault) = sync_settings::read_vault_path(&data_directory) else {
                    return;
                };
                // Told once, not on every pass: this runs again in thirty
                // seconds, and a window asked the same question that often
                // learns nothing it did not already know.
                let news = match storage.export_pending(&vault, &store_root) {
                    // Nothing here can fix it, and the marks stay put — the
                    // next pass tries the same documents again.
                    Err(error) => status.set_write(Some(error.to_string())),
                    Ok(_) => status.set_write(None),
                };
                if news {
                    say_status_changed(&window);
                }
            }
        };
        let runtime = Self {
            session_id,
            storage,
            assets,
            data_directory,
            original_directory,
            service,
            export_renderer,
            export_publisher,
            initial_boot: Mutex::new(Some(initial_boot)),
            status,
            watch: Mutex::new(None),
            sync: sync_runtime::SyncRuntime::start(exporter),
        };
        // A session can end with work still queued — a crash, a folder that
        // was unreachable, a vault picked after the edits were made. Nothing
        // else would ask.
        runtime.sync.poke();
        Ok(runtime)
    }

    /// Every command that changes anything ends here, and this is the only
    /// thing that wakes the export thread. A mutation that forgets it is a
    /// note the folder never learns about until something else is edited.
    pub(crate) fn changed<T>(&self, outcome: Result<T, NotesError>) -> Result<T, NotesError> {
        if outcome.is_ok() {
            self.sync.poke();
        }
        outcome
    }

    /// Starts watching the folder the user picked, replacing any earlier
    /// watch. Nothing here is fatal: a folder that cannot be watched still
    /// exports, and the app is more use without a watch than not at all.
    fn watch_vault(&self, app: &tauri::AppHandle) {
        let Some(vault) = sync_settings::read_vault_path(&self.data_directory) else {
            return;
        };
        let telling = app.clone();
        let status = Arc::clone(&self.status);
        let storage = Arc::clone(&self.storage);
        let service = Arc::clone(&self.service);
        let exporting = self.sync.handle();
        let window = app.clone();
        let started = vault_watch::VaultWatch::start(
            Arc::clone(&self.storage),
            Arc::clone(&self.assets),
            vault,
            move || say_status_changed(&telling),
            move |outcome: notes_sync::merger::MergeOutcome| {
                // Whatever the merge decided, the folder may now owe a
                // write — this is the only thing that wakes the exporter for
                // it.
                exporting.poke();
                let Ok(revision) = storage.revision() else {
                    return;
                };
                if outcome.applied == 0 {
                    // Nothing in the outline moved, so there is nothing for
                    // the window to redraw.
                    return;
                }
                let (out_of_reach, changed) = announce(&outcome, revision);
                // The session first: a window told about a revision the service
                // does not know about would have every later edit rejected.
                let _ = service.absorb_external(revision, &out_of_reach);
                let _ = window.emit("notes://sync-changed", changed);
            },
        );
        let news = match started {
            Ok(watch) => {
                if let Ok(mut held) = self.watch.lock() {
                    *held = Some(watch);
                }
                status.set_watch(None)
            }
            // The folder the user picked is not being read. Nothing else in
            // the app can tell them that.
            Err(reason) => status.set_watch(Some(reason)),
        };
        if news {
            say_status_changed(app);
        }
    }

    fn clear_initial_boot(&self) -> Result<(), NotesError> {
        self.initial_boot
            .lock()
            .map_err(|_| internal_error("The initial Notes snapshot lock was poisoned."))?
            .take();
        Ok(())
    }
}

/// The window asks what the state is; this only says that it moved. A watch
/// that fails at startup does so before anything is listening, so the answer
/// has to be available to whoever asks late rather than carried by the event.
fn say_status_changed(window: &tauri::AppHandle) {
    let _ = window.emit("notes://sync-status", ());
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

/// Gives a platform that cannot ask for a folder one to sync into.
///
/// iOS has no folder picker worth the name — nothing it offers grants the
/// standing access a background sync needs — so the vault is this app's own
/// iCloud container, adopted on the first run and never touched again. Every
/// desktop passes through: the folder there is the user's to name, and
/// choosing one for them would start writing notes somewhere they never
/// picked.
///
/// A failure here is left quiet on purpose. The vault stays unset, which is
/// the state the app already knows how to be in and already has a screen for,
/// and the alternative — refusing to start — would be worse than starting
/// without sync.
fn adopt_platform_vault(data_directory: &Path) {
    let stored = sync_settings::read_vault_path(data_directory);
    let Some(place) = notes_sync::icloud::first_run_vault(stored, platform_vault) else {
        return;
    };
    let path = place.path();
    if std::fs::create_dir_all(path).is_err() {
        return;
    }
    let _ = sync_settings::set_vault_path(data_directory, path);
}

/// Where this platform would put a vault if it had to choose. Only iOS does.
#[cfg(target_os = "ios")]
fn platform_vault() -> Option<notes_sync::icloud::VaultPlace> {
    Some(notes_sync::icloud::vault_root(
        notes_sync::icloud::container,
        || {
            // iCloud is off or signed out. The app still has to be writable,
            // and `Local` is what tells the screen to say so.
            std::env::var_os("HOME")
                .map(|home| PathBuf::from(home).join("Documents"))
                .unwrap_or_else(std::env::temp_dir)
        },
    ))
}

#[cfg(not(target_os = "ios"))]
fn platform_vault() -> Option<notes_sync::icloud::VaultPlace> {
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
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
            let watching = app.handle().clone();
            let startup_data_directory = data_directory.clone();
            app.manage(DesktopState {
                runtime: Arc::clone(&runtime),
                data_directory: data_directory.clone(),
                closed: AtomicBool::new(false),
            });
            std::thread::Builder::new()
                .name("notes-v2-startup".into())
                .spawn(move || {
                    runtime.complete(DesktopRuntime::initialize(
                        data_directory,
                        font_path,
                        watching.clone(),
                    ));
                    // Before the watcher, because on a phone this is what
                    // gives it something to watch: iOS has no folder picker,
                    // so a first run adopts the app's own iCloud container
                    // rather than waiting for an answer nobody can give.
                    adopt_platform_vault(&startup_data_directory);
                    // After the gate opens, so a command arriving mid-startup
                    // waits for the same runtime this is about to hand a
                    // watcher rather than a second one.
                    if let Ok(ready) = runtime.wait() {
                        ready.watch_vault(&watching);
                    }
                })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            notes_bootstrap,
            notes_pages,
            notes_query_viewport,
            notes_query_forest,
            notes_execute,
            notes_undo,
            notes_redo,
            notes_search,
            notes_close_session,
            notes_unused_assets,
            notes_delete_all_data,
            notes_sync_conflicts,
            notes_sync_restore_conflict,
            notes_sync_forget_conflict,
            notes_sync_attachments,
            notes_sync_status,
            notes_sync_delete_attachment,
            notes_sync_flush,
            notes_sync_vault_get,
            notes_sync_vault_set,
            notes_rebuild_from_vault,
            notes_onboarding_write_guide,
            notes_onboarding_first_run,
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

/// What this outcome has to say, in the two directions it has to say it.
///
/// First, the rows it put beyond this session's reach: another device's edit
/// landed on them, so replaying a history entry that touches one would throw
/// that edit away with nothing said. Second, what the window is told — a
/// notice that cannot say which note changed sends it back to re-reading the
/// whole page, and that path does not promise the caret stays where it was.
///
/// The two are not the same list, which is the whole point of this function.
/// A picture's bytes turning up settles rows the window has to redraw while
/// discarding nothing at all, so those rows are in the second and never in the
/// first. Answered together, and in different shapes, so the two cannot be
/// handed to each other's caller.
/// What this Mac is called, the way its owner sees it in System Settings —
/// "Suwon의 MacBook Pro" rather than the dotted hostname a network sees. It
/// travels out in the vault files, so another device can name the machine that
/// overwrote a note instead of naming four hexadecimal characters.
///
/// A subprocess because there is no API for the friendly name short of linking
/// SystemConfiguration, and this is asked once per launch. Anything unexpected —
/// no `scutil`, a non-zero exit, an empty answer — leaves the device unnamed,
/// which the settings screen already has an answer for.
#[cfg(target_os = "macos")]
fn computer_name() -> Option<String> {
    let output = std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let name = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    // A name that is not one line is not statable in the vault's frontmatter,
    // and the renderer would drop it anyway.
    if name.is_empty() || name.contains(['\n', '\r']) {
        return None;
    }
    Some(name)
}

#[cfg(not(target_os = "macos"))]
fn computer_name() -> Option<String> {
    None
}

fn announce(
    outcome: &notes_sync::merger::MergeOutcome,
    revision: u64,
) -> (Vec<String>, SyncChanged) {
    (
        outcome
            .changed_ids
            .iter()
            .chain(outcome.deleted_ids.iter())
            .cloned()
            .collect(),
        SyncChanged {
            revision,
            changed_node_ids: outcome
                .changed_ids
                .iter()
                .chain(outcome.settled_ids.iter())
                .cloned()
                .collect(),
            deleted_node_ids: outcome.deleted_ids.iter().cloned().collect(),
        },
    )
}

/// The snapshot the runtime opened with, for as long as the database is still
/// where that snapshot left it. `initialize` reads it before the vault sweep has
/// merged a single document, and a sweep that merged anything moved the
/// revision: handing the window rows from before that is handing it a number
/// the session has already left, which is its next keystroke refused. Taken
/// either way — a snapshot the sweep has outrun can never become current
/// again, so the next ask reads the database rather than this.
fn current_boot(cached: Option<BootSnapshot>, live_revision: u64) -> Option<BootSnapshot> {
    cached.filter(|snapshot| snapshot.revision == live_revision)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A picture's bytes turning up settles rows without anyone editing them,
    /// so nothing about it can put a history entry out of reach. Naming those
    /// rows is for the window's redraw and for nothing else — read the two
    /// lists as one and the user loses an undo because a download finished.
    #[test]
    fn an_arriving_picture_puts_no_history_out_of_reach() {
        // All three at once, which the sweep never actually reports in one
        // outcome — it calls back per queue entry, so a document and a picture
        // arrive as two. Deliberately stronger than production: one outcome
        // carrying every kind is what makes both halves answerable in one
        // assertion.
        let outcome = notes_sync::merger::MergeOutcome {
            applied: 3,
            changed_ids: std::collections::BTreeSet::from(["edited".to_owned()]),
            deleted_ids: std::collections::BTreeSet::from(["removed".to_owned()]),
            settled_ids: std::collections::BTreeSet::from(["shot".to_owned()]),
            ..notes_sync::merger::MergeOutcome::default()
        };

        let (out_of_reach, changed) = announce(&outcome, 7);

        assert_eq!(
            out_of_reach,
            vec!["edited".to_owned(), "removed".to_owned()],
            "what another device edited or removed, and the settled picture in \
             neither -- nobody edited that note, its bytes simply turned up"
        );
        assert_eq!(
            changed,
            SyncChanged {
                revision: 7,
                changed_node_ids: vec!["edited".to_owned(), "shot".to_owned()],
                deleted_node_ids: vec!["removed".to_owned()],
            },
            "the window redraws the settled row like any other"
        );
    }

    /// The snapshot the runtime opens with is read before the vault sweep has
    /// merged a single document, so a sweep that merged anything has made it a
    /// lie: the window would be handed rows and a revision the database has
    /// already left behind, and its first keystroke would be refused against a
    /// number nobody ever told it.
    #[test]
    fn a_boot_snapshot_the_database_has_outgrown_is_not_served() {
        let cached = BootSnapshot {
            session_id: "session-1".to_owned(),
            revision: 0,
            active_page_id: None,
            pages: Vec::new(),
            viewport: None,
            history: notes_application::HistoryState {
                can_undo: false,
                can_redo: false,
                undo_depth: 0,
                redo_depth: 0,
            },
        };

        assert!(
            current_boot(Some(cached.clone()), 13).is_none(),
            "thirteen merged documents later, the snapshot describes notes the \
             window would never be able to edit"
        );
        assert_eq!(
            current_boot(Some(cached.clone()), 0),
            Some(cached),
            "and a database still where the snapshot left it is answered from \
             the snapshot, which is the whole of what caching it buys"
        );
    }

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

    /// The reset exists for a startup that failed, so it cannot ask the
    /// startup gate for anything: the gate answers a failed start with that
    /// same failure forever, which would kill the one way out.
    #[test]
    fn a_reset_requested_without_a_runtime_clears_the_database_on_next_start() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let data = directory.path().join("app-data");
        std::fs::create_dir_all(&data).expect("data");
        let database = data.join("notes-v2.sqlite");
        std::fs::write(&database, b"not a working database").expect("database");

        request_data_deletion(&data).expect("request");
        apply_pending_data_deletion(&data).expect("reset");

        assert!(
            !database.exists(),
            "the next start opens a fresh database, not the broken one"
        );
        assert!(
            !data.join(DELETE_DATA_MARKER).exists(),
            "and the request is spent, so the start after it keeps its data"
        );
    }

    /// Nothing waits on the startup thread any more, so the request can now
    /// arrive before that thread has made the directory it writes into.
    #[test]
    fn a_reset_can_be_requested_before_the_data_directory_exists() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let data = directory.path().join("app-data");

        request_data_deletion(&data).expect("request");

        assert!(
            data.join(DELETE_DATA_MARKER).exists(),
            "the request survives to the start that carries it out"
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

    /// The wire shape the window reads, pinned against the generated
    /// TypeScript: `packages/contracts/generated/SyncStatus.ts` says these
    /// names, and a rename on either side has to fail here rather than in a
    /// badge that quietly shows nothing.
    #[test]
    fn sync_status_serializes_the_generated_typescript_wire_shape() {
        let status = SyncStatus {
            refused: vec![notes_application::RefusedFile {
                path: "journal/today.md".to_owned(),
                reason: "이 앱이 읽는 문서가 아니다".to_owned(),
            }],
            write_error: Some("the folder is read only".to_owned()),
            watch_error: None,
        };

        let wire = serde_json::to_value(&status).expect("status must serialize");

        assert_eq!(wire["refused"][0]["path"], "journal/today.md");
        assert_eq!(wire["refused"][0]["reason"], "이 앱이 읽는 문서가 아니다");
        assert_eq!(wire["writeError"], "the folder is read only");
        assert!(wire["watchError"].is_null());
        assert!(wire.get("write_error").is_none());
        assert_eq!(
            serde_json::from_value::<SyncStatus>(wire).expect("and read back"),
            status
        );
    }

    /// The wire shape the settings screen reads, pinned against
    /// `packages/contracts/generated/VaultRebuildReport.ts`, and the two numbers
    /// it is made of.
    ///
    /// `merged` is the trap. It counts documents that changed a row, so a folder
    /// the database already agrees with merges nothing — reporting that would
    /// tell the user nothing was found where the truth is that every file was
    /// read and every one already matched. `read` is the count a person can hold
    /// against their own folder, and `skipped` is the one that says a note is
    /// missing because this build could not read its file.
    #[test]
    fn the_rebuild_report_serializes_the_generated_typescript_wire_shape() {
        let report = rebuild_report(notes_sqlite::ReindexReport {
            read: 12,
            merged: 0,
            skipped: 1,
        });

        let wire = serde_json::to_value(report).expect("report must serialize");

        assert_eq!(
            wire["documents"], 12,
            "the folder held twelve documents this build could read"
        );
        assert_eq!(wire["unreadable"], 1, "and one it could not");
        assert_eq!(
            serde_json::from_value::<VaultRebuildReport>(wire).expect("and read back"),
            report
        );
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
