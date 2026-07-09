use crate::notes::repository::{
    connect_notes_db, create_node, duplicate_node, empty_trash, load_workspace, move_node,
    remove_empty_node, restore_node, soft_delete_node, split_node, toggle_collapsed,
    toggle_complete, update_node,
};
use crate::notes::types::{
    CreateNodeInput, MoveNodeInput, NotesWorkspace, NotesWorkspaceScope, SplitNodeInput,
    UpdateNodeInput,
};

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
    create_node(&mut connection, input)?;
    load_workspace(&connection, NotesWorkspaceScope::Active)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_update_node(
    vault_path: String,
    input: UpdateNodeInput,
) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    update_node(&mut connection, input)?;
    load_workspace(&connection, NotesWorkspaceScope::Active)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_split_node(
    vault_path: String,
    input: SplitNodeInput,
) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    split_node(&mut connection, input)?;
    load_workspace(&connection, NotesWorkspaceScope::Active)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_move_node(
    vault_path: String,
    input: MoveNodeInput,
) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    move_node(&mut connection, input)?;
    load_workspace(&connection, NotesWorkspaceScope::Active)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_toggle_complete(
    vault_path: String,
    node_id: String,
) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    toggle_complete(&mut connection, &node_id)?;
    load_workspace(&connection, NotesWorkspaceScope::Active)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_toggle_collapsed(
    vault_path: String,
    node_id: String,
) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    toggle_collapsed(&mut connection, &node_id)?;
    load_workspace(&connection, NotesWorkspaceScope::Active)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_duplicate_node(
    vault_path: String,
    node_id: String,
) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    duplicate_node(&mut connection, &node_id)?;
    load_workspace(&connection, NotesWorkspaceScope::Active)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_remove_empty_node(
    vault_path: String,
    node_id: String,
) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    remove_empty_node(&mut connection, &node_id)?;
    load_workspace(&connection, NotesWorkspaceScope::Active)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_soft_delete_node(
    vault_path: String,
    node_id: String,
) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    soft_delete_node(&mut connection, &node_id)?;
    load_workspace(&connection, NotesWorkspaceScope::Active)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_restore_node(
    vault_path: String,
    node_id: String,
) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    restore_node(&mut connection, &node_id)?;
    load_workspace(&connection, NotesWorkspaceScope::Active)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_empty_trash(vault_path: String) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    empty_trash(&mut connection)?;
    load_workspace(&connection, NotesWorkspaceScope::Active)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notes::types::{NoteLayoutMode, NoteNode};
    use serde_json::json;

    const ROOT_ID: &str = "11111111-1111-4111-8111-111111111111";
    const SPLIT_ID: &str = "22222222-2222-4222-8222-222222222222";
    const EMPTY_ID: &str = "33333333-3333-4333-8333-333333333333";

    fn assert_active(workspace: &NotesWorkspace) {
        assert!(workspace.nodes.iter().all(|node| node.deleted_at.is_none()));
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
                    "deletedAt": null
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
}
