use crate::file_io::write_atomic_file;
use crate::notes::export::{load_export_snapshot, render_markdown, render_pdf};
use crate::notes::repository::{
    archive_node, connect_notes_db, create_node, delete_database, duplicate_node, empty_trash,
    list_tags, list_tags_with_counts, load_workspace, move_node, open_notes_export_db,
    remove_empty_node, restore_node, search_nodes, soft_delete_node, split_node, toggle_collapsed,
    toggle_complete, toggle_star, unarchive_node, update_node,
};
use crate::notes::types::{
    validate_note_id, CreateNodeInput, MoveNodeInput, NoteSearchResult, NoteTagSummary,
    NotesExportFormat, NotesExportResult, NotesExportSnapshot, NotesWorkspace, NotesWorkspaceScope,
    SplitNodeInput, UpdateNodeInput,
};
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_initialize(vault_path: String) -> Result<(), String> {
    connect_notes_db(&vault_path).map(|_| ())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_load_workspace(
    vault_path: String,
    scope: NotesWorkspaceScope,
) -> Result<NotesWorkspace, String> {
    let connection = connect_notes_db(&vault_path)?;
    load_workspace(&connection, scope)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_create_node(
    vault_path: String,
    input: CreateNodeInput,
) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    create_node(&mut connection, input)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_update_node(
    vault_path: String,
    input: UpdateNodeInput,
) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    update_node(&mut connection, input)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_split_node(
    vault_path: String,
    input: SplitNodeInput,
) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    split_node(&mut connection, input)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_move_node(
    vault_path: String,
    input: MoveNodeInput,
) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    move_node(&mut connection, input)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_toggle_complete(
    vault_path: String,
    node_id: String,
) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    toggle_complete(&mut connection, &node_id)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_toggle_collapsed(
    vault_path: String,
    node_id: String,
) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    toggle_collapsed(&mut connection, &node_id)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_toggle_star(
    vault_path: String,
    node_id: String,
) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    toggle_star(&mut connection, &node_id)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_duplicate_node(
    vault_path: String,
    node_id: String,
) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    duplicate_node(&mut connection, &node_id)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_remove_empty_node(
    vault_path: String,
    node_id: String,
) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    remove_empty_node(&mut connection, &node_id)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_soft_delete_node(
    vault_path: String,
    node_id: String,
) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    soft_delete_node(&mut connection, &node_id)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_restore_node(
    vault_path: String,
    node_id: String,
) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    restore_node(&mut connection, &node_id)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_archive_node(
    vault_path: String,
    node_id: String,
) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    archive_node(&mut connection, &node_id)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_unarchive_node(
    vault_path: String,
    node_id: String,
) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    unarchive_node(&mut connection, &node_id)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_empty_trash(vault_path: String) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    empty_trash(&mut connection)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_search(
    vault_path: String,
    query: String,
) -> Result<Vec<NoteSearchResult>, String> {
    let connection = connect_notes_db(&vault_path)?;
    search_nodes(&connection, &query)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_list_tags(vault_path: String) -> Result<Vec<String>, String> {
    let connection = connect_notes_db(&vault_path)?;
    list_tags(&connection)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_list_tags_with_counts(
    vault_path: String,
) -> Result<Vec<NoteTagSummary>, String> {
    let connection = connect_notes_db(&vault_path)?;
    list_tags_with_counts(&connection)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_delete_database(vault_path: String) -> Result<(), String> {
    delete_database(&vault_path)
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
        Ok(_) => Err("Destination already exists.".to_string()),
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

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_export_markdown(
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
        NotesExportFormat::Markdown,
        render_markdown,
    )
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_export_pdf(
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
    renderer: fn(&NotesExportSnapshot) -> Result<Vec<u8>, String>,
) -> Result<NotesExportResult, String> {
    validate_note_id(&root_node_id)?;
    let destination_path = export_destination_path(&destination)?;
    ensure_export_destination_is_not_directory(&destination_path)?;
    if !overwrite {
        ensure_export_destination_is_available(&destination_path)?;
    }

    let connection = open_notes_export_db(&vault_path)?;
    let snapshot = load_export_snapshot(&connection, &root_node_id)?;
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
    use crate::notes::types::{
        NoteLayoutMode, NoteNode, NoteSearchMatchedField, NoteSearchResult, NotesExportFormat,
    };
    use serde_json::json;

    const ROOT_ID: &str = "11111111-1111-4111-8111-111111111111";
    const SPLIT_ID: &str = "22222222-2222-4222-8222-222222222222";
    const EMPTY_ID: &str = "33333333-3333-4333-8333-333333333333";
    const INVALID_DESCENDANT_ID: &str = "bad -->\n# injected";

    fn assert_active(workspace: &NotesWorkspace) {
        assert!(workspace.nodes.iter().all(|node| node.deleted_at.is_none()));
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
                }]
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
        )
        .expect("create");
        assert_active(&workspace);

        let workspace = notes_update_node(
            vault_path.clone(),
            UpdateNodeInput {
                id: ROOT_ID.to_string(),
                title: "Updated page".to_string(),
                note: "Context".to_string(),
            },
        )
        .expect("update");
        assert_eq!(workspace.nodes[0].title, "Updated page");

        let workspace = notes_split_node(
            vault_path.clone(),
            SplitNodeInput {
                id: ROOT_ID.to_string(),
                new_node_id: SPLIT_ID.to_string(),
                prefix: "First".to_string(),
                suffix: "Second".to_string(),
            },
        )
        .expect("split");
        assert_active(&workspace);

        notes_create_node(
            vault_path.clone(),
            CreateNodeInput {
                id: EMPTY_ID.to_string(),
                parent_id: Some(ROOT_ID.to_string()),
                after_id: None,
                title: String::new(),
                note: String::new(),
            },
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
        )
        .expect("move");
        assert_active(&workspace);

        let workspace = notes_toggle_complete(vault_path.clone(), ROOT_ID.to_string())
            .expect("toggle complete");
        assert!(workspace
            .nodes
            .iter()
            .find(|node| node.id == ROOT_ID)
            .unwrap()
            .completed_at
            .is_some());

        let workspace = notes_toggle_collapsed(vault_path.clone(), ROOT_ID.to_string())
            .expect("toggle collapsed");
        assert!(
            workspace
                .nodes
                .iter()
                .find(|node| node.id == ROOT_ID)
                .unwrap()
                .is_collapsed
        );

        let workspace =
            notes_duplicate_node(vault_path.clone(), ROOT_ID.to_string()).expect("duplicate");
        assert_eq!(workspace.nodes.len(), 6);
        assert_active(&workspace);

        let workspace = notes_remove_empty_node(vault_path.clone(), EMPTY_ID.to_string())
            .expect("remove empty");
        assert_eq!(workspace.nodes.len(), 5);
        assert_active(&workspace);

        let workspace =
            notes_soft_delete_node(vault_path.clone(), SPLIT_ID.to_string()).expect("soft delete");
        assert_eq!(workspace.nodes.len(), 4);
        assert_active(&workspace);
        assert_eq!(
            notes_load_workspace(vault_path.clone(), NotesWorkspaceScope::Trash)
                .expect("trash workspace")
                .nodes
                .len(),
            2
        );

        let workspace =
            notes_restore_node(vault_path.clone(), SPLIT_ID.to_string()).expect("restore");
        assert_eq!(workspace.nodes.len(), 5);
        assert_active(&workspace);

        notes_soft_delete_node(vault_path.clone(), SPLIT_ID.to_string())
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
        )
        .expect("create searchable node");

        assert_eq!(
            notes_search(vault_path.clone(), "target".to_string())
                .expect("search")
                .first()
                .expect("search result")
                .node_id,
            ROOT_ID
        );
        assert_eq!(
            notes_list_tags(vault_path.clone()).expect("list tags"),
            vec!["roadmap"]
        );
        assert!(
            notes_toggle_star(vault_path.clone(), ROOT_ID.to_string())
                .expect("toggle star")
                .nodes[0]
                .is_starred
        );

        notes_delete_database(vault_path.clone()).expect("delete database");
        assert!(!crate::notes::repository::notes_db_path(&vault_path).exists());
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
