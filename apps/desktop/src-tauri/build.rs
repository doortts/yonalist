const APP_COMMANDS: &[&str] = &[
    "notes_bootstrap",
    "notes_query_viewport",
    "notes_query_forest",
    "notes_execute",
    "notes_undo",
    "notes_redo",
    "notes_search",
    "notes_close_session",
    "notes_import_image_bytes",
    "notes_import_image_paths",
    "notes_read_image",
];

fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));
    tauri_build::try_build(attributes).expect("failed to run Yonalist v2 Tauri build script");
}
