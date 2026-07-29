use std::sync::Arc;

use notes_application::{NotesError, NotesExportRequest, NotesExportResult};
use tauri::State;

use super::{DesktopState, run_blocking};

#[tauri::command]
pub(super) async fn notes_export(
    state: State<'_, DesktopState>,
    request: NotesExportRequest,
) -> Result<NotesExportResult, NotesError> {
    let gate = Arc::clone(&state.runtime);
    run_blocking(move || {
        let runtime = gate.wait()?;
        runtime.clear_initial_boot()?;
        runtime.service.export(
            request,
            runtime.assets.as_ref(),
            runtime.export_renderer.as_ref(),
            runtime.export_publisher.as_ref(),
        )
    })
    .await
}
