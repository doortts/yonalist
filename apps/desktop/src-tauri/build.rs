const APP_COMMANDS: &[&str] = &[
    "notes_bootstrap",
    "notes_query_viewport",
    "notes_query_forest",
    "notes_execute",
    "notes_undo",
    "notes_redo",
    "notes_search",
    "notes_sync_vault_get",
    "notes_sync_vault_set",
    "notes_close_session",
    "notes_export",
    "notes_import_image_bytes",
    "notes_import_image_paths",
    "notes_read_image",
    "notes_replace_image_bytes",
    "notes_replace_image_path",
    "notes_view_image_original",
    "notes_download_image",
    "notes_toggle_devtools",
    "notes_unused_assets",
    "notes_delete_all_data",
    "open_external_url",
];

fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));
    tauri_build::try_build(attributes).expect("failed to run Yonalist v2 Tauri build script");
}
