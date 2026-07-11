use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type NoteId = String;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteNode {
    pub id: NoteId,
    pub parent_id: Option<NoteId>,
    pub sort_key: i64,
    pub title: String,
    pub note: String,
    pub layout_mode: NoteLayoutMode,
    pub is_collapsed: bool,
    pub is_starred: bool,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub archived_at: Option<String>,
    pub archive_root_id: Option<NoteId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteAttachment {
    pub id: String,
    #[serde(alias = "node_id")]
    pub node_id: NoteId,
    #[serde(alias = "sort_key")]
    pub sort_key: i64,
    #[serde(alias = "relative_path")]
    pub relative_path: String,
    #[serde(alias = "content_hash")]
    pub content_hash: String,
    #[serde(alias = "original_name")]
    pub original_name: String,
    #[serde(alias = "mime_type")]
    pub mime_type: String,
    #[serde(alias = "byte_size")]
    pub byte_size: i64,
    #[serde(alias = "intrinsic_width")]
    pub intrinsic_width: i64,
    #[serde(alias = "intrinsic_height")]
    pub intrinsic_height: i64,
    #[serde(alias = "display_width")]
    pub display_width: i64,
    #[serde(alias = "created_at")]
    pub created_at: String,
    #[serde(alias = "updated_at")]
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotesExportSnapshot {
    pub root_node_id: NoteId,
    pub title: String,
    pub exported_at: String,
    pub root: ExportNode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportAttachment {
    pub id: String,
    pub relative_path: String,
    pub content_hash: String,
    pub original_name: String,
    pub mime_type: String,
    pub byte_size: i64,
    pub intrinsic_width: i64,
    pub intrinsic_height: i64,
    pub display_width: i64,
    pub bytes: Option<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportDateSpan {
    pub start_utf16: usize,
    pub end_utf16: usize,
    pub normalized_start: String,
    pub normalized_end: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportNode {
    pub id: NoteId,
    pub title: String,
    pub note: String,
    pub title_date_spans: Vec<ExportDateSpan>,
    pub note_date_spans: Vec<ExportDateSpan>,
    pub completed: bool,
    pub attachments: Vec<ExportAttachment>,
    pub children: Vec<ExportNode>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NotesExportFormat {
    Markdown,
    Pdf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotesExportResult {
    pub destination: String,
    pub format: NotesExportFormat,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NoteLayoutMode {
    Bullets,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotesWorkspace {
    pub nodes: Vec<NoteNode>,
    pub attachments_by_node_id: BTreeMap<NoteId, Vec<NoteAttachment>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotesMutationResult {
    pub workspace: NotesWorkspace,
    pub history_entry_id: Option<String>,
    pub can_undo: bool,
    pub can_redo: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportAttachmentInput {
    pub id: String,
    pub node_id: NoteId,
    pub source_path: String,
    pub display_width: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResizeAttachmentInput {
    pub id: String,
    pub display_width: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotesHistoryContext {
    pub session_id: String,
    pub entry_id: String,
    pub command_kind: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotesHistoryStatus {
    pub can_undo: bool,
    pub can_redo: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotesHistoryReplayResult {
    pub workspace: NotesWorkspace,
    pub replayed_entry_id: Option<String>,
    pub can_undo: bool,
    pub can_redo: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum NoteTagPrefix {
    #[serde(rename = "#")]
    Hash,
    #[serde(rename = "@")]
    Mention,
}

impl NoteTagPrefix {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Hash => "#",
            Self::Mention => "@",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteTagFilter {
    pub prefix: NoteTagPrefix,
    pub normalized_tag: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteSearchTag {
    pub prefix: NoteTagPrefix,
    pub normalized_tag: String,
    pub display_tag: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteStructuredSearchQuery {
    pub text: String,
    pub required_tags: Vec<NoteSearchTag>,
    pub excluded_tags: Vec<NoteSearchTag>,
    pub or_groups: Vec<Vec<NoteSearchTag>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteTagSummary {
    pub prefix: NoteTagPrefix,
    pub normalized_tag: String,
    pub display_tag: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum NotesWorkspaceScope {
    Active,
    Starred,
    Recent,
    Tag { tag: String },
    Tags { tags: Vec<NoteTagFilter> },
    Archive,
    Trash,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum NoteSearchScope {
    Active,
    Archive,
    Trash,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NoteSearchMatchedField {
    Title,
    Note,
    Date,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteSearchResult {
    pub node_id: NoteId,
    pub title: String,
    pub parent_trail: Vec<String>,
    pub matched_field: NoteSearchMatchedField,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateNodeInput {
    pub id: NoteId,
    pub parent_id: Option<NoteId>,
    pub after_id: Option<NoteId>,
    pub title: String,
    pub note: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNodeInput {
    pub id: NoteId,
    pub title: String,
    pub note: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MoveNodeInput {
    pub id: NoteId,
    pub parent_id: Option<NoteId>,
    pub after_id: Option<NoteId>,
    pub before_id: Option<NoteId>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SplitNodeInput {
    pub id: NoteId,
    pub new_node_id: NoteId,
    pub prefix: String,
    pub suffix: String,
}

pub(crate) fn validate_note_id(id: &str) -> Result<(), String> {
    let bytes = id.as_bytes();
    let has_canonical_shape = bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes[14] == b'4'
        && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit());

    if has_canonical_shape {
        Ok(())
    } else {
        Err("Note ID must be a canonical UUID v4 string.".to_string())
    }
}

fn validate_optional_note_id(id: Option<&str>) -> Result<(), String> {
    id.map(validate_note_id).unwrap_or(Ok(()))
}

impl CreateNodeInput {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_note_id(&self.id)?;
        validate_optional_note_id(self.parent_id.as_deref())?;
        validate_optional_note_id(self.after_id.as_deref())?;
        if self.parent_id.as_deref() == Some(self.id.as_str()) {
            return Err("A new node cannot be its own parent.".to_string());
        }
        if self.after_id.as_deref() == Some(self.id.as_str()) {
            return Err("A new node cannot be placed after itself.".to_string());
        }
        Ok(())
    }
}

impl UpdateNodeInput {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_note_id(&self.id)
    }
}

impl MoveNodeInput {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_note_id(&self.id)?;
        validate_optional_note_id(self.parent_id.as_deref())?;
        validate_optional_note_id(self.after_id.as_deref())?;
        validate_optional_note_id(self.before_id.as_deref())?;
        if self.after_id.is_some() && self.before_id.is_some() {
            return Err("A node move cannot specify both afterId and beforeId.".to_string());
        }
        if self.parent_id.as_deref() == Some(self.id.as_str()) {
            return Err("A node cannot be moved under itself.".to_string());
        }
        if self.after_id.as_deref() == Some(self.id.as_str()) {
            return Err("A node cannot be placed after itself.".to_string());
        }
        if self.before_id.as_deref() == Some(self.id.as_str()) {
            return Err("A node cannot be placed before itself.".to_string());
        }
        Ok(())
    }
}

impl SplitNodeInput {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_note_id(&self.id)?;
        validate_note_id(&self.new_node_id)?;
        if self.id == self.new_node_id {
            return Err("A split node must use a fresh Note ID.".to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        validate_note_id, MoveNodeInput, NoteAttachment, NoteSearchMatchedField, NoteSearchScope,
        NoteSearchTag, NoteStructuredSearchQuery, NoteTagFilter, NoteTagPrefix, NoteTagSummary,
        NotesExportFormat, NotesExportResult, NotesHistoryContext, NotesHistoryReplayResult,
        NotesHistoryStatus, NotesMutationResult, NotesWorkspace, NotesWorkspaceScope,
    };
    use serde_json::json;

    const NODE_ID: &str = "11111111-1111-4111-8111-111111111111";
    const SECOND_ID: &str = "22222222-2222-4222-8222-222222222222";
    const THIRD_ID: &str = "33333333-3333-4333-8333-333333333333";

    #[test]
    fn validates_only_canonical_uuid_v4_ids() {
        assert!(validate_note_id("11111111-1111-4111-8111-111111111111").is_ok());
        assert!(validate_note_id("AAAAAAAA-AAAA-4AAA-BAAA-AAAAAAAAAAAA").is_ok());

        for invalid in [
            "11111111-1111-3111-8111-111111111111",
            "11111111-1111-4111-7111-111111111111",
            "11111111111141118111111111111111",
            "not-a-uuid",
        ] {
            assert!(
                validate_note_id(invalid).is_err(),
                "accepted invalid ID {invalid}"
            );
        }
    }

    #[test]
    fn move_rejects_conflicting_and_self_anchors() {
        let conflicting = MoveNodeInput {
            id: NODE_ID.to_string(),
            parent_id: None,
            after_id: Some(SECOND_ID.to_string()),
            before_id: Some(THIRD_ID.to_string()),
        };
        assert_eq!(
            conflicting.validate().expect_err("conflicting anchors"),
            "A node move cannot specify both afterId and beforeId."
        );

        let self_anchored = MoveNodeInput {
            id: NODE_ID.to_string(),
            parent_id: None,
            after_id: None,
            before_id: Some(NODE_ID.to_string()),
        };
        assert_eq!(
            self_anchored.validate().expect_err("self before anchor"),
            "A node cannot be placed before itself."
        );
    }

    #[test]
    fn markdown_export_result_uses_the_exact_camel_case_lowercase_wire_contract() {
        let result = NotesExportResult {
            destination: "/tmp/project.md".to_string(),
            format: NotesExportFormat::Markdown,
        };

        assert_eq!(
            serde_json::to_value(result).expect("serialize export result"),
            json!({
                "destination": "/tmp/project.md",
                "format": "markdown"
            })
        );
    }

    #[test]
    fn pdf_export_result_uses_the_exact_camel_case_lowercase_wire_contract() {
        let result = NotesExportResult {
            destination: "/tmp/project.pdf".to_string(),
            format: NotesExportFormat::Pdf,
        };

        assert_eq!(
            serde_json::to_value(result).expect("serialize PDF export result"),
            json!({
                "destination": "/tmp/project.pdf",
                "format": "pdf"
            })
        );
    }

    #[test]
    fn archive_and_structured_tag_contracts_use_exact_native_wire_shapes() {
        let archive: NotesWorkspaceScope =
            serde_json::from_value(json!({ "kind": "archive" })).expect("archive scope");
        assert_eq!(archive, NotesWorkspaceScope::Archive);

        let tags: NotesWorkspaceScope = serde_json::from_value(json!({
            "kind": "tags",
            "tags": [
                { "prefix": "#", "normalizedTag": "roadmap" },
                { "prefix": "@", "normalizedTag": "minji" }
            ]
        }))
        .expect("structured tag scope");
        assert_eq!(
            tags,
            NotesWorkspaceScope::Tags {
                tags: vec![
                    NoteTagFilter {
                        prefix: NoteTagPrefix::Hash,
                        normalized_tag: "roadmap".to_string(),
                    },
                    NoteTagFilter {
                        prefix: NoteTagPrefix::Mention,
                        normalized_tag: "minji".to_string(),
                    },
                ]
            }
        );

        let summary = NoteTagSummary {
            prefix: NoteTagPrefix::Mention,
            normalized_tag: "minji".to_string(),
            display_tag: "Minji".to_string(),
            count: 2,
        };
        assert_eq!(
            serde_json::to_value(summary).expect("counted tag summary"),
            json!({
                "prefix": "@",
                "normalizedTag": "minji",
                "displayTag": "Minji",
                "count": 2
            })
        );
    }

    #[test]
    fn notes_tag_search_query_uses_the_exact_camel_case_wire_shape() {
        let query: NoteStructuredSearchQuery = serde_json::from_value(json!({
            "text": "release notes",
            "requiredTags": [
                { "prefix": "#", "normalizedTag": "roadmap", "displayTag": "Roadmap" }
            ],
            "excludedTags": [
                { "prefix": "@", "normalizedTag": "bot", "displayTag": "BOT" }
            ],
            "orGroups": [[
                { "prefix": "#", "normalizedTag": "desktop", "displayTag": "Desktop" },
                { "prefix": "@", "normalizedTag": "platform", "displayTag": "Platform" }
            ]]
        }))
        .expect("structured search query");

        assert_eq!(query.text, "release notes");
        assert_eq!(
            query.required_tags,
            vec![NoteSearchTag {
                prefix: NoteTagPrefix::Hash,
                normalized_tag: "roadmap".to_string(),
                display_tag: "Roadmap".to_string(),
            }]
        );
        assert_eq!(query.or_groups[0][1].prefix, NoteTagPrefix::Mention);
    }

    #[test]
    fn notes_date_search_scope_and_match_use_the_exact_wire_shape() {
        let scope: NoteSearchScope =
            serde_json::from_value(json!({ "kind": "trash" })).expect("date search scope");
        assert_eq!(scope, NoteSearchScope::Trash);
        assert_eq!(
            serde_json::to_value(NoteSearchMatchedField::Date).expect("date match field"),
            json!("date")
        );
    }

    #[test]
    fn history_contracts_use_exact_camel_case_wire_shapes() {
        let context: NotesHistoryContext = serde_json::from_value(json!({
            "sessionId": NODE_ID,
            "entryId": SECOND_ID,
            "commandKind": "updateText"
        }))
        .expect("history context");
        assert_eq!(context.session_id, NODE_ID);
        assert_eq!(context.entry_id, SECOND_ID);
        assert_eq!(context.command_kind, "updateText");

        let replay = NotesHistoryReplayResult {
            workspace: NotesWorkspace {
                nodes: Vec::new(),
                attachments_by_node_id: std::collections::BTreeMap::new(),
            },
            replayed_entry_id: Some(SECOND_ID.to_string()),
            can_undo: true,
            can_redo: false,
        };
        assert_eq!(
            serde_json::to_value(replay).expect("history replay result"),
            json!({
                "workspace": { "nodes": [], "attachmentsByNodeId": {} },
                "replayedEntryId": SECOND_ID,
                "canUndo": true,
                "canRedo": false
            })
        );
        assert_eq!(
            serde_json::to_value(NotesHistoryStatus::default()).expect("history status"),
            json!({ "canUndo": false, "canRedo": false })
        );

        let mutation = NotesMutationResult {
            workspace: NotesWorkspace {
                nodes: Vec::new(),
                attachments_by_node_id: std::collections::BTreeMap::new(),
            },
            history_entry_id: Some(SECOND_ID.to_string()),
            can_undo: true,
            can_redo: false,
        };
        assert_eq!(
            serde_json::to_value(mutation).expect("mutation result"),
            json!({
                "workspace": { "nodes": [], "attachmentsByNodeId": {} },
                "historyEntryId": SECOND_ID,
                "canUndo": true,
                "canRedo": false
            })
        );
    }

    #[test]
    fn attachment_contracts_use_ordered_camel_case_workspace_shapes() {
        let attachment = NoteAttachment {
            id: SECOND_ID.to_string(),
            node_id: NODE_ID.to_string(),
            sort_key: 1024,
            relative_path:
                "notes-assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png"
                    .to_string(),
            content_hash: "a".repeat(64),
            original_name: "image.png".to_string(),
            mime_type: "image/png".to_string(),
            byte_size: 123,
            intrinsic_width: 320,
            intrinsic_height: 200,
            display_width: 240,
            created_at: "2026-07-11T00:00:00.000Z".to_string(),
            updated_at: "2026-07-11T00:00:01.000Z".to_string(),
        };
        let workspace = NotesWorkspace {
            nodes: Vec::new(),
            attachments_by_node_id: std::collections::BTreeMap::from([(
                NODE_ID.to_string(),
                vec![attachment],
            )]),
        };

        assert_eq!(
            serde_json::to_value(workspace).expect("attachment workspace"),
            json!({
                "nodes": [],
                "attachmentsByNodeId": {
                    NODE_ID: [{
                        "id": SECOND_ID,
                        "nodeId": NODE_ID,
                        "sortKey": 1024,
                        "relativePath": "notes-assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
                        "contentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                        "originalName": "image.png",
                        "mimeType": "image/png",
                        "byteSize": 123,
                        "intrinsicWidth": 320,
                        "intrinsicHeight": 200,
                        "displayWidth": 240,
                        "createdAt": "2026-07-11T00:00:00.000Z",
                        "updatedAt": "2026-07-11T00:00:01.000Z"
                    }]
                }
            })
        );
    }
}
