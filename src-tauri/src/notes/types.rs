use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::Arc;

use crate::notes::github_notifications::{
    is_valid_github_date_key, is_valid_github_notification_key,
    is_valid_github_notification_metadata, GithubNotificationsPluginMeta,
    GithubNotificationsPluginState, GITHUB_NOTIFICATIONS_ROOT_ID,
    MAX_GITHUB_NOTIFICATION_METADATA_UTF8_BYTES,
};
use crate::notes::sync::topic_file::is_app_timestamp;
use crate::notes::tags::is_canonical_tag_body;

pub type NoteId = String;
pub(crate) const MAX_NOTE_ATTACHMENTS_PER_NODE: i64 = 128;
pub(crate) const MAX_NOTE_ATTACHMENTS_PER_VAULT: i64 = 512;
pub(crate) const MAX_IMAGE_NODE_IMPORT_ITEMS: usize = 128;
pub(crate) const MAX_NOTES_EXPORT_ATTACHMENTS: usize = 512;
pub(crate) const MAX_BATCH_NODE_IDS: usize = 10_000;
pub(crate) const MAX_GITHUB_NOTIFICATION_REFRESH_UTF8_BYTES: usize = 16 * 1024 * 1024;

pub(crate) fn deserialize_required_nullable<'de, D, T>(
    deserializer: D,
) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

/// Bounds for `notes_import_subtree` (paste import). The whole import runs as a
/// single transaction + single history entry, so it is bounded to a sane node
/// count and nesting depth. The depth cap also lets the validator and the
/// inserter walk the forest iteratively (no recursion), so a pathologically
/// deep payload cannot overflow the stack. Field caps stop one absurd
/// title/note from bloating the payload; content is otherwise stored verbatim
/// like every other node.
pub(crate) const MAX_IMPORT_SUBTREE_NODES: usize = 2000;
pub(crate) const MAX_IMPORT_SUBTREE_DEPTH: usize = 64;
pub(crate) const MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES: usize = 100_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NoteNodeKind {
    Text,
    Image,
}

impl NoteNodeKind {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Image => "image",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NoteMarkerKind {
    #[default]
    Bullet,
    Todo,
}

impl NoteMarkerKind {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Bullet => "bullet",
            Self::Todo => "todo",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteNode {
    pub id: NoteId,
    pub node_kind: NoteNodeKind,
    pub marker_kind: NoteMarkerKind,
    pub parent_id: Option<NoteId>,
    pub sort_key: i64,
    pub title: String,
    pub note: String,
    pub image_offset_utf16: i64,
    pub markdown_image_width: Option<i64>,
    pub layout_mode: NoteLayoutMode,
    pub is_collapsed: bool,
    pub is_starred: bool,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub archived_at: Option<String>,
    pub archive_root_id: Option<NoteId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_readonly: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_state: Option<GithubNotificationsPluginState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_meta: Option<GithubNotificationsPluginMeta>,
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
    pub bytes: Option<Arc<[u8]>>,
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
    pub node_kind: NoteNodeKind,
    pub marker_kind: NoteMarkerKind,
    pub title: String,
    pub note: String,
    pub image_offset_utf16: i64,
    pub title_date_spans: Vec<ExportDateSpan>,
    pub note_date_spans: Vec<ExportDateSpan>,
    pub completed: bool,
    pub attachments: Vec<ExportAttachment>,
    pub children: Vec<ExportNode>,
}

impl ExportNode {
    pub(crate) fn validate_for_export(&self) -> Result<(), String> {
        crate::notes::schema::validate_image_offset_utf16(
            &self.title,
            self.node_kind,
            self.image_offset_utf16,
        )?;
        if self.node_kind == NoteNodeKind::Image && self.attachments.len() != 1 {
            return Err(format!(
                "Image Note node {} must own exactly one attachment for export; found {}.",
                self.id,
                self.attachments.len()
            ));
        }
        for child in &self.children {
            child.validate_for_export()?;
        }
        Ok(())
    }
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
    #[serde(flatten)]
    pub state: NotesHistoryState,
    /// Incremental deltas derived from the mutation's history audit rows.
    ///
    /// These are populated only when the mutation ran with a history context
    /// (the audit triggers are the source). When they are `None` the full
    /// `workspace` above remains authoritative, so the fields are optional and
    /// omitted from the wire payload to keep the contract additive.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed_nodes: Option<Vec<NoteNode>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed_node_ids: Option<Vec<NoteId>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed_attachments: Option<Vec<NoteAttachment>>,
    /// New root ids created by `notes_import_subtree`, in the order the caller
    /// supplied them. Populated only by that command (every other mutation
    /// leaves it `None` and the field is omitted from the wire payload); the
    /// frontend focuses `importedRootIds[0]`. This carries only the imported
    /// roots — the full imported forest is available via `workspace` /
    /// `changedNodes`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported_root_ids: Option<Vec<NoteId>>,
    /// New root ids created by a batch duplicate, in source order. Every other
    /// mutation leaves this `None`, so it is omitted from the wire payload.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicated_root_ids: Option<Vec<NoteId>>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportAttachmentInput {
    #[serde(default)]
    pub request_id: Option<String>,
    pub id: String,
    pub node_id: NoteId,
    pub source_path: String,
    pub initial_max_display_width: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportNotesMarkdownInput {
    pub source_path: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub parent_id: Option<NoteId>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub after_id: Option<NoteId>,
}

impl ImportNotesMarkdownInput {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.source_path.trim().is_empty() {
            return Err("A Notes Markdown import source path is required.".to_string());
        }
        validate_optional_note_id(self.parent_id.as_deref())?;
        validate_optional_note_id(self.after_id.as_deref())?;
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportAttachmentPathBatchInput {
    #[serde(default)]
    pub(crate) request_id: Option<String>,
    pub(crate) node_id: String,
    pub(crate) attachments: Vec<ImportAttachmentPathItem>,
    pub(crate) initial_max_display_width: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportAttachmentPathItem {
    pub(crate) id: String,
    pub(crate) source_path: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportImageNodePathsInput {
    #[serde(default)]
    pub(crate) request_id: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub(crate) parent_id: Option<NoteId>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub(crate) after_id: Option<NoteId>,
    pub(crate) items: Vec<ImportImageNodePathItem>,
    pub(crate) initial_max_display_width: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportImageNodePathItem {
    pub(crate) node_id: NoteId,
    pub(crate) attachment_id: String,
    pub(crate) source_path: String,
}

impl ImportImageNodePathsInput {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_image_node_batch_fields(
            self.parent_id.as_deref(),
            self.after_id.as_deref(),
            self.initial_max_display_width,
            self.items
                .iter()
                .map(|item| (item.node_id.as_str(), item.attachment_id.as_str())),
        )
    }
}

pub(crate) fn validate_image_node_batch_fields<'a>(
    parent_id: Option<&str>,
    after_id: Option<&str>,
    initial_max_display_width: i64,
    ids: impl ExactSizeIterator<Item = (&'a str, &'a str)>,
) -> Result<(), String> {
    if let Some(parent_id) = parent_id {
        validate_note_id(parent_id)?;
    }
    if let Some(after_id) = after_id {
        validate_note_id(after_id)?;
    }
    if initial_max_display_width <= 0 {
        return Err(
            "A Notes image node initial maximum display width must be positive.".to_string(),
        );
    }
    let item_count = ids.len();
    if item_count == 0 || item_count > MAX_IMAGE_NODE_IMPORT_ITEMS {
        return Err(format!(
            "A Notes image node batch must contain between 1 and {MAX_IMAGE_NODE_IMPORT_ITEMS} images."
        ));
    }

    let mut node_ids = HashSet::with_capacity(item_count);
    let mut attachment_ids = HashSet::with_capacity(item_count);
    for (node_id, attachment_id) in ids {
        validate_note_id(node_id)?;
        validate_note_id(attachment_id).map_err(|_| {
            "A Notes image node attachment ID must be a canonical UUID v4 string.".to_string()
        })?;
        if !node_ids.insert(node_id) {
            return Err(format!(
                "A Notes image node batch contains duplicate node ID {node_id}."
            ));
        }
        if !attachment_ids.insert(attachment_id) {
            return Err(format!(
                "A Notes image node batch contains duplicate attachment ID {attachment_id}."
            ));
        }
        let overlapping_id = if attachment_ids.contains(node_id) {
            Some(node_id)
        } else if node_ids.contains(attachment_id) {
            Some(attachment_id)
        } else {
            None
        };
        if let Some(overlapping_id) = overlapping_id {
            return Err(format!(
                "A Notes image node batch contains ID {overlapping_id} used as both a node and attachment ID."
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResizeAttachmentInput {
    pub id: String,
    pub display_width: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotesHistoryContext {
    pub session_id: String,
    pub history_epoch: String,
    pub entry_id: String,
    pub command_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageAtomFocusResult {
    pub node_id: NoteId,
    pub anchor_utf16: i64,
    pub focus_utf16: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageAtomOperationReceiptResult {
    pub operation_id: String,
    pub history_epoch: String,
    pub postcondition_digest: String,
    pub affected_root_ids: Vec<NoteId>,
    pub focus: ImageAtomFocusResult,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogicalSelection {
    pub anchor_utf16: i64,
    pub focus_utf16: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageTargetAuthority {
    pub node_id: NoteId,
    pub expected_updated_at: String,
    pub expected_title: String,
    pub expected_image_offset_utf16: i64,
    pub expected_primary_attachment_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ImageAtomEdit {
    Remove { replacement_text: String },
    Enter { sibling_id: NoteId },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyImageAtomEditInput {
    pub target: ImageTargetAuthority,
    pub selection: LogicalSelection,
    pub edit: ImageAtomEdit,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageAtomPasteTargetAuthority {
    pub node_id: NoteId,
    pub expected_updated_at: String,
    pub expected_node_kind: NoteNodeKind,
    pub expected_title: String,
    pub expected_image_offset_utf16: i64,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub expected_primary_attachment_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ImageAtomPasteFragmentItem {
    Text {
        text: String,
    },
    Image {
        node_id: NoteId,
        attachment_id: String,
        ordinal: u32,
        original_name: String,
        mime_type: String,
        byte_length: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyImageAtomPasteInput {
    pub target: ImageAtomPasteTargetAuthority,
    pub selection: LogicalSelection,
    pub version: u8,
    pub fragment: Vec<ImageAtomPasteFragmentItem>,
    pub initial_max_display_width: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImageAtomMutationResult {
    #[serde(flatten)]
    pub mutation: NotesMutationResult,
    pub operation: ImageAtomOperationReceiptResult,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ImageAtomOperationLookup {
    Found {
        receipt: ImageAtomOperationReceiptResult,
    },
    Missing {
        history_epoch: String,
    },
    EpochMismatch {
        history_epoch: String,
    },
}

#[cfg(test)]
pub(crate) const TEST_CURRENT_HISTORY_EPOCH: &str = "__test_current_history_epoch__";

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotesHistoryState {
    pub can_undo: bool,
    pub can_redo: bool,
    pub history_epoch: String,
    pub next_undo_entry_id: Option<String>,
    pub next_redo_entry_id: Option<String>,
    pub pruned_entry_ids: Vec<String>,
}

pub type NotesHistoryStatus = NotesHistoryState;

impl std::ops::Deref for NotesMutationResult {
    type Target = NotesHistoryState;

    fn deref(&self) -> &Self::Target {
        &self.state
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotesInitializeInput {
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotesHistoryReplayRequest {
    pub session_id: String,
    pub history_epoch: String,
    pub expected_entry_id: String,
    pub scope: NotesWorkspaceScope,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotesPruneHistoryInput {
    pub session_id: String,
    pub history_epoch: String,
    pub entry_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotesHistoryResetInput {
    pub session_id: String,
    pub history_epoch: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum NotesHistoryReplayOutcome {
    Applied {
        workspace: NotesWorkspace,
        replayed_entry_id: String,
        #[serde(flatten)]
        state: NotesHistoryState,
    },
    EpochMismatch {
        #[serde(flatten)]
        state: NotesHistoryState,
    },
    EntryMissing {
        #[serde(flatten)]
        state: NotesHistoryState,
    },
    EntryNotNext {
        #[serde(flatten)]
        state: NotesHistoryState,
    },
}

/// Internal test/replay compatibility view. Tauri commands expose
/// [`NotesHistoryReplayOutcome`] so callers must name the exact entry they expect.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg(test)]
pub struct NotesHistoryReplayResult {
    pub workspace: NotesWorkspace,
    pub replayed_entry_id: Option<String>,
    #[serde(flatten)]
    pub state: NotesHistoryState,
}

#[cfg(test)]
impl std::ops::Deref for NotesHistoryReplayResult {
    type Target = NotesHistoryState;

    fn deref(&self) -> &Self::Target {
        &self.state
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotesPrepareNavigationInput {
    pub session_id: String,
    pub history_epoch: String,
    pub unreachable_redo_entry_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotesHistoryCloseInput {
    pub session_id: String,
    pub history_epoch: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotesHistoryResetResult {
    pub workspace: NotesWorkspace,
    pub history_reset: bool,
    #[serde(flatten)]
    pub state: NotesHistoryState,
}

impl std::ops::Deref for NotesHistoryResetResult {
    type Target = NotesHistoryState;

    fn deref(&self) -> &Self::Target {
        &self.state
    }
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
    Attachment,
    Date,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteSearchResult {
    pub node_id: NoteId,
    pub node_kind: NoteNodeKind,
    pub title: String,
    pub image_offset_utf16: i64,
    pub attachment_name: Option<String>,
    pub display_label: String,
    pub parent_trail: Vec<String>,
    pub parent_trail_kinds: Vec<NoteNodeKind>,
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
    #[serde(default)]
    pub marker_kind: NoteMarkerKind,
}

/// One node in a `notes_import_subtree` payload. Ids are generated on the
/// backend (never supplied by the client) so the store stays authoritative, so
/// only content + nesting is carried here. `note`/`children` default to
/// empty when omitted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportNode {
    pub title: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub marker_kind: NoteMarkerKind,
    #[serde(default)]
    pub children: Vec<ImportNode>,
}

/// Input to `notes_import_subtree`: a forest of new nodes inserted as one
/// contiguous block under `parentId`, right after `afterId`. The whole import
/// is one transaction + one history entry, so undo removes every imported node
/// in a single step.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportSubtreeInput {
    #[serde(default)]
    pub parent_id: Option<NoteId>,
    #[serde(default)]
    pub after_id: Option<NoteId>,
    pub nodes: Vec<ImportNode>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNodeInput {
    pub id: NoteId,
    pub title: String,
    pub note: String,
    pub image_offset_utf16: i64,
    #[serde(default)]
    pub markdown_image_width: Option<i64>,
    pub marker_kind: NoteMarkerKind,
}

/// Toggles the ordinary user-managed readonly flag. Plugin-owned rows never
/// accept this input; their provider ownership is the protection boundary.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
pub(crate) struct SetReadonlyInput {
    pub(crate) node_id: NoteId,
    pub(crate) is_readonly: bool,
}

/// Delete request carrying the exact readonly-descendant set acknowledged by
/// the user. `None` is a preflight request and must never write.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeleteNodesInput {
    pub(crate) node_ids: Vec<NoteId>,
    #[serde(default)]
    pub(crate) expected_readonly_descendant_ids: Option<Vec<NoteId>>,
}

impl DeleteNodesInput {
    #[allow(dead_code)]
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.node_ids.is_empty() {
            return Err("A Notes delete requires at least one node.".to_string());
        }
        if self.node_ids.len() > MAX_BATCH_NODE_IDS {
            return Err("A Notes delete can contain at most 10,000 node IDs.".to_string());
        }
        let mut seen = BTreeSet::new();
        for node_id in &self.node_ids {
            validate_note_id(node_id)?;
            if !seen.insert(node_id) {
                return Err(format!(
                    "A Notes delete contains duplicate node ID {node_id}."
                ));
            }
        }
        if let Some(ids) = &self.expected_readonly_descendant_ids {
            if ids.len() > MAX_BATCH_NODE_IDS {
                return Err("A Notes readonly confirmation contains too many node IDs.".to_string());
            }
            let mut seen = BTreeSet::new();
            for node_id in ids {
                validate_note_id(node_id)?;
                if !seen.insert(node_id) {
                    return Err(format!(
                        "A Notes readonly confirmation contains duplicate node ID {node_id}."
                    ));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(untagged, rename_all = "camelCase")]
#[allow(dead_code)]
pub(crate) enum DeleteNodesOutcome {
    Deleted(NotesMutationResult),
    NeedsReadonlyConfirmation {
        #[serde(rename = "readonlyDescendantIds")]
        readonly_descendant_ids: Vec<NoteId>,
    },
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MoveNodeInput {
    pub id: NoteId,
    pub parent_id: Option<NoteId>,
    pub after_id: Option<NoteId>,
    pub before_id: Option<NoteId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GithubNotificationSnapshotInput {
    pub date_key: String,
    pub notification_key: String,
    pub title: String,
    pub note: String,
    pub notification_type: String,
    pub url: String,
    pub updated_at: String,
    pub unread: bool,
}

impl GithubNotificationSnapshotInput {
    fn payload_utf8_bytes(&self) -> Option<usize> {
        [
            self.date_key.len(),
            self.notification_key.len(),
            self.title.len(),
            self.note.len(),
            self.notification_type.len(),
            self.url.len(),
            self.updated_at.len(),
        ]
        .into_iter()
        .try_fold(0usize, usize::checked_add)
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        if !is_valid_github_date_key(&self.date_key) {
            return Err("A GitHub notification date key is invalid.".to_string());
        }
        if !is_valid_github_notification_metadata(
            &self.notification_key,
            &self.notification_type,
            &self.url,
            &self.updated_at,
        ) {
            return Err("A GitHub notification snapshot is invalid.".to_string());
        }
        for (field, value) in [("title", &self.title), ("note", &self.note)] {
            if value.len() > MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES {
                return Err(format!("A GitHub notification {field} is too large."));
            }
        }
        if self.payload_utf8_bytes().is_none() {
            return Err("A GitHub notification snapshot is too large.".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum MaterializeGithubNotificationTarget {
    #[serde(rename = "sibling")]
    Sibling {
        #[serde(rename = "siblingId")]
        sibling_id: NoteId,
    },
    #[serde(rename = "children")]
    Children { nodes: Vec<ImportNode> },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterializeGithubNotificationInput {
    pub root_id: NoteId,
    pub snapshot: GithubNotificationSnapshotInput,
    pub target: MaterializeGithubNotificationTarget,
}

impl MaterializeGithubNotificationInput {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_note_id(&self.root_id)?;
        if self.root_id != GITHUB_NOTIFICATIONS_ROOT_ID {
            return Err("The GitHub notification root ID is invalid.".to_string());
        }
        self.snapshot.validate()?;
        match &self.target {
            MaterializeGithubNotificationTarget::Sibling { sibling_id } => {
                validate_note_id(sibling_id)
            }
            MaterializeGithubNotificationTarget::Children { nodes } => validate_import_nodes(nodes),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterializeGithubNotificationSiblingInput {
    pub root_id: NoteId,
    pub sibling_id: NoteId,
    pub snapshot: GithubNotificationSnapshotInput,
}

impl MaterializeGithubNotificationSiblingInput {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_note_id(&self.root_id)?;
        validate_note_id(&self.sibling_id)?;
        if self.root_id != GITHUB_NOTIFICATIONS_ROOT_ID {
            return Err("The GitHub notification root ID is invalid.".to_string());
        }
        self.snapshot.validate()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterializeGithubNotificationReparentInput {
    pub root_id: NoteId,
    pub node_id: NoteId,
    pub snapshot: GithubNotificationSnapshotInput,
}

impl MaterializeGithubNotificationReparentInput {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_note_id(&self.root_id)?;
        validate_note_id(&self.node_id)?;
        if self.root_id != GITHUB_NOTIFICATIONS_ROOT_ID {
            return Err("The GitHub notification root ID is invalid.".to_string());
        }
        self.snapshot.validate()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefreshGithubNotificationsInput {
    pub root_id: NoteId,
    pub notifications: Vec<GithubNotificationSnapshotInput>,
}

impl RefreshGithubNotificationsInput {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_note_id(&self.root_id)?;
        if self.root_id != GITHUB_NOTIFICATIONS_ROOT_ID {
            return Err("The GitHub notification root ID is invalid.".to_string());
        }
        if self.notifications.len() > MAX_BATCH_NODE_IDS {
            return Err(
                "A GitHub notification refresh can contain at most 10,000 rows.".to_string(),
            );
        }
        let mut keys = BTreeSet::new();
        let mut aggregate_bytes = 0usize;
        for snapshot in &self.notifications {
            snapshot.validate()?;
            aggregate_bytes = aggregate_bytes
                .checked_add(snapshot.payload_utf8_bytes().ok_or_else(|| {
                    "A GitHub notification refresh payload is too large.".to_string()
                })?)
                .ok_or_else(|| "A GitHub notification refresh payload is too large.".to_string())?;
            if aggregate_bytes > MAX_GITHUB_NOTIFICATION_REFRESH_UTF8_BYTES {
                return Err(format!(
                    "A GitHub notification refresh can contain at most \
                     {MAX_GITHUB_NOTIFICATION_REFRESH_UTF8_BYTES} UTF-8 bytes."
                ));
            }
            if !keys.insert(snapshot.notification_key.as_str()) {
                return Err("A GitHub notification refresh contains duplicate keys.".to_string());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetGithubGroupCollapsedInput {
    pub root_id: NoteId,
    pub group_key: String,
    pub collapsed: bool,
}

impl SetGithubGroupCollapsedInput {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_note_id(&self.root_id)?;
        if self.root_id != GITHUB_NOTIFICATIONS_ROOT_ID
            || !is_valid_github_date_key(&self.group_key)
        {
            return Err("The GitHub notification group is invalid.".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkGithubNotificationReadInput {
    pub root_id: NoteId,
    pub notification_key: String,
    pub updated_at: String,
}

impl MarkGithubNotificationReadInput {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_note_id(&self.root_id)?;
        if self.root_id != GITHUB_NOTIFICATIONS_ROOT_ID
            || self.notification_key.len() > MAX_GITHUB_NOTIFICATION_METADATA_UTF8_BYTES
            || self.updated_at.len() > MAX_GITHUB_NOTIFICATION_METADATA_UTF8_BYTES
            || !is_valid_github_notification_key(&self.notification_key)
            || !is_app_timestamp(&self.updated_at)
        {
            return Err("The GitHub notification read request is invalid.".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SplitNodeInput {
    pub id: NoteId,
    pub new_node_id: NoteId,
    pub prefix: String,
    pub suffix: String,
}

/// One structural operation applied to a *set* of selected nodes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BatchOp {
    /// Set the completion state of every selected node to `completed`
    /// (idempotent: already-matching nodes are untouched).
    Complete { completed: bool },
    /// Soft-delete every selected node as ONE trash batch (they share a single
    /// `deleted_batch_id`).
    Delete,
    /// Move the selected nodes as a contiguous block under `parentId`, after
    /// `afterId` or before `beforeId`, preserving their order in `nodeIds`.
    Move {
        parent_id: Option<NoteId>,
        after_id: Option<NoteId>,
        before_id: Option<NoteId>,
    },
    /// Indent each eligible selected node under its nearest preceding sibling
    /// that is not itself selected.
    Indent,
    /// Outdent each eligible selected node up one level (after its old parent).
    Outdent,
    /// Duplicate the selected forest roots as one contiguous copied block.
    Duplicate,
    /// Add one canonical display tag to every explicitly selected node.
    AddTag { tag: NoteSearchTag },
    /// Remove every exact occurrence of one canonical tag from each selected node.
    RemoveTag { tag: NoteTagFilter },
}

/// Input to `notes_apply_batch`: a set of node ids plus the operation to apply
/// to all of them in one transaction / one history entry. Deserialized from the
/// internally-tagged wire shape `{ "op": "move", "nodeIds": [...], "parentId": ... }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyBatchInput {
    pub node_ids: Vec<NoteId>,
    pub op: BatchOp,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyBatchSearchTagWire {
    prefix: NoteTagPrefix,
    normalized_tag: String,
    display_tag: String,
}

impl From<ApplyBatchSearchTagWire> for NoteSearchTag {
    fn from(tag: ApplyBatchSearchTagWire) -> Self {
        Self {
            prefix: tag.prefix,
            normalized_tag: tag.normalized_tag,
            display_tag: tag.display_tag,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyBatchTagFilterWire {
    prefix: NoteTagPrefix,
    normalized_tag: String,
}

impl From<ApplyBatchTagFilterWire> for NoteTagFilter {
    fn from(tag: ApplyBatchTagFilterWire) -> Self {
        Self {
            prefix: tag.prefix,
            normalized_tag: tag.normalized_tag,
        }
    }
}

/// A wire field that must be present while still allowing an explicit JSON
/// `null`. A bare `Option<T>` also treats a missing serde field as `None`, which
/// would let a malformed move silently default to the root/end destination.
#[derive(Deserialize)]
#[serde(untagged)]
enum RequiredNullable<T> {
    Value(T),
    Null,
}

impl<T> RequiredNullable<T> {
    fn into_option(self) -> Option<T> {
        match self {
            Self::Value(value) => Some(value),
            Self::Null => None,
        }
    }
}

/// Wire representation of [`ApplyBatchInput`]: an internally-tagged enum with the
/// op-specific fields at the top level. This shape deserializes reliably, whereas
/// a `#[serde(flatten)]` `BatchOp` silently drops fields — serde flatten and
/// internally tagged enums do not compose.
#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum ApplyBatchWire {
    Complete {
        node_ids: Vec<NoteId>,
        completed: bool,
    },
    Delete {
        node_ids: Vec<NoteId>,
    },
    Move {
        node_ids: Vec<NoteId>,
        parent_id: RequiredNullable<NoteId>,
        after_id: RequiredNullable<NoteId>,
        before_id: Option<NoteId>,
    },
    Indent {
        node_ids: Vec<NoteId>,
    },
    Outdent {
        node_ids: Vec<NoteId>,
    },
    Duplicate {
        node_ids: Vec<NoteId>,
    },
    AddTag {
        node_ids: Vec<NoteId>,
        tag: ApplyBatchSearchTagWire,
    },
    RemoveTag {
        node_ids: Vec<NoteId>,
        tag: ApplyBatchTagFilterWire,
    },
}

fn dedup_batch_node_ids(node_ids: Vec<NoteId>) -> Vec<NoteId> {
    let mut seen = BTreeSet::new();
    node_ids
        .into_iter()
        .filter(|node_id| seen.insert(node_id.clone()))
        .collect()
}

impl<'de> Deserialize<'de> for ApplyBatchInput {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let input = match ApplyBatchWire::deserialize(deserializer)? {
            ApplyBatchWire::Complete {
                node_ids,
                completed,
            } => ApplyBatchInput {
                node_ids,
                op: BatchOp::Complete { completed },
            },
            ApplyBatchWire::Delete { node_ids } => ApplyBatchInput {
                node_ids,
                op: BatchOp::Delete,
            },
            ApplyBatchWire::Move {
                node_ids,
                parent_id,
                after_id,
                before_id,
            } => ApplyBatchInput {
                node_ids,
                op: BatchOp::Move {
                    parent_id: parent_id.into_option(),
                    after_id: after_id.into_option(),
                    before_id,
                },
            },
            ApplyBatchWire::Indent { node_ids } => ApplyBatchInput {
                node_ids,
                op: BatchOp::Indent,
            },
            ApplyBatchWire::Outdent { node_ids } => ApplyBatchInput {
                node_ids,
                op: BatchOp::Outdent,
            },
            ApplyBatchWire::Duplicate { node_ids } => ApplyBatchInput {
                node_ids,
                op: BatchOp::Duplicate,
            },
            ApplyBatchWire::AddTag { node_ids, tag } => ApplyBatchInput {
                node_ids,
                op: BatchOp::AddTag { tag: tag.into() },
            },
            ApplyBatchWire::RemoveTag { node_ids, tag } => ApplyBatchInput {
                node_ids,
                op: BatchOp::RemoveTag { tag: tag.into() },
            },
        };
        if input.node_ids.is_empty() {
            return Err(serde::de::Error::custom(
                "A batch operation requires at least one node.",
            ));
        }
        if input.node_ids.len() > MAX_BATCH_NODE_IDS {
            return Err(serde::de::Error::custom(
                "A batch operation can contain at most 10,000 node IDs.",
            ));
        }
        Ok(ApplyBatchInput {
            node_ids: dedup_batch_node_ids(input.node_ids),
            op: input.op,
        })
    }
}

impl ApplyBatchInput {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.node_ids.is_empty() {
            return Err("A batch operation requires at least one node.".to_string());
        }
        if self.node_ids.len() > MAX_BATCH_NODE_IDS {
            return Err("A batch operation can contain at most 10,000 node IDs.".to_string());
        }
        for id in &self.node_ids {
            validate_note_id(id)?;
        }
        if let BatchOp::Move {
            parent_id,
            after_id,
            before_id,
        } = &self.op
        {
            validate_optional_note_id(parent_id.as_deref())?;
            validate_optional_note_id(after_id.as_deref())?;
            validate_optional_note_id(before_id.as_deref())?;
            if after_id.is_some() && before_id.is_some() {
                return Err("A batch move cannot specify both afterId and beforeId.".to_string());
            }
        }
        let normalized_tag = match &self.op {
            BatchOp::AddTag { tag } => Some(&tag.normalized_tag),
            BatchOp::RemoveTag { tag } => Some(&tag.normalized_tag),
            _ => None,
        };
        if normalized_tag.is_some_and(|tag| !is_canonical_tag_body(tag)) {
            return Err(
                "Structured Notes search tag normalizedTag must be a canonical tag body."
                    .to_string(),
            );
        }
        Ok(())
    }
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
        validate_note_id(&self.id)?;
        if self.image_offset_utf16 < 0 {
            return Err("A Notes image offset must not be negative.".to_string());
        }
        crate::notes::schema::validate_markdown_image_width(self.markdown_image_width)?;
        Ok(())
    }
}

impl ImportSubtreeInput {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_optional_note_id(self.parent_id.as_deref())?;
        validate_optional_note_id(self.after_id.as_deref())?;
        validate_import_nodes(&self.nodes)
    }
}

pub(crate) fn validate_import_nodes(nodes: &[ImportNode]) -> Result<(), String> {
    if nodes.is_empty() {
        return Err("A subtree import requires at least one node.".to_string());
    }
    // Walk the forest iteratively (never recursively) so a pathologically
    // deep payload cannot overflow the stack here or in the inserter, and
    // reject absurd sizes / oversized fields before any write begins.
    let mut total = 0usize;
    let mut stack: Vec<(&ImportNode, usize)> = nodes.iter().map(|node| (node, 1usize)).collect();
    while let Some((node, depth)) = stack.pop() {
        total += 1;
        if total > MAX_IMPORT_SUBTREE_NODES {
            return Err(format!(
                "A subtree import cannot exceed {MAX_IMPORT_SUBTREE_NODES} nodes."
            ));
        }
        if depth > MAX_IMPORT_SUBTREE_DEPTH {
            return Err(format!(
                "A subtree import cannot nest deeper than {MAX_IMPORT_SUBTREE_DEPTH} levels."
            ));
        }
        if node.title.len() > MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES {
            return Err("An imported Note title is too long.".to_string());
        }
        if node.note.as_deref().map_or(0, str::len) > MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES {
            return Err("An imported Note note is too long.".to_string());
        }
        for child in &node.children {
            stack.push((child, depth + 1));
        }
    }
    Ok(())
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
        validate_note_id, ApplyBatchInput, BatchOp, DeleteNodesOutcome,
        GithubNotificationSnapshotInput, ImportAttachmentPathBatchInput, ImportImageNodePathsInput,
        ImportNode, ImportNotesMarkdownInput, MarkGithubNotificationReadInput,
        MaterializeGithubNotificationInput, MaterializeGithubNotificationTarget, MoveNodeInput,
        NoteAttachment, NoteLayoutMode, NoteMarkerKind, NoteNode, NoteNodeKind,
        NoteSearchMatchedField, NoteSearchResult, NoteSearchScope, NoteSearchTag,
        NoteStructuredSearchQuery, NoteTagFilter, NoteTagPrefix, NoteTagSummary, NotesExportFormat,
        NotesExportResult, NotesHistoryContext, NotesHistoryReplayOutcome, NotesHistoryState,
        NotesMutationResult, NotesWorkspace, NotesWorkspaceScope, RefreshGithubNotificationsInput,
        UpdateNodeInput, MAX_BATCH_NODE_IDS, MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES,
    };
    use crate::notes::github_notifications::GITHUB_NOTIFICATIONS_ROOT_ID;
    use serde_json::json;

    const NODE_ID: &str = "11111111-1111-4111-8111-111111111111";
    const SECOND_ID: &str = "22222222-2222-4222-8222-222222222222";
    const THIRD_ID: &str = "33333333-3333-4333-8333-333333333333";

    fn history_state() -> NotesHistoryState {
        NotesHistoryState {
            can_undo: true,
            can_redo: false,
            history_epoch: THIRD_ID.to_string(),
            next_undo_entry_id: Some(SECOND_ID.to_string()),
            next_redo_entry_id: None,
            pruned_entry_ids: Vec::new(),
        }
    }

    fn note_node() -> NoteNode {
        NoteNode {
            marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
            id: NODE_ID.to_string(),
            node_kind: NoteNodeKind::Text,
            parent_id: None,
            sort_key: 1024,
            title: "Root".to_string(),
            note: String::new(),
            image_offset_utf16: 0,
            markdown_image_width: None,
            layout_mode: NoteLayoutMode::Bullets,
            is_collapsed: false,
            is_starred: true,
            completed_at: None,
            created_at: "2026-07-11T00:00:00.000Z".to_string(),
            updated_at: "2026-07-11T00:00:01.000Z".to_string(),
            deleted_at: None,
            archived_at: None,
            archive_root_id: None,
            is_readonly: None,
            plugin_state: None,
            plugin_meta: None,
        }
    }

    fn github_snapshot(remote_id: &str) -> GithubNotificationSnapshotInput {
        GithubNotificationSnapshotInput {
            date_key: "2026.07.21".to_string(),
            notification_key: format!(
                "[\"github\",\"[\\\"https://api.github.com\\\",\\\"account-7\\\"]\",\"{remote_id}\"]"
            ),
            title: "Issue title".to_string(),
            note: "Repository: example/repo".to_string(),
            notification_type: "Issue".to_string(),
            url: format!("https://github.com/example/repo/issues/{remote_id}"),
            updated_at: "2026-07-21T00:00:00Z".to_string(),
            unread: true,
        }
    }

    #[test]
    fn github_materialize_target_uses_an_exact_tagged_wire_contract() {
        let sibling: MaterializeGithubNotificationInput = serde_json::from_value(json!({
            "rootId": GITHUB_NOTIFICATIONS_ROOT_ID,
            "snapshot": github_snapshot("42"),
            "target": {
                "kind": "sibling",
                "siblingId": SECOND_ID
            }
        }))
        .expect("sibling target");
        assert_eq!(
            sibling.target,
            MaterializeGithubNotificationTarget::Sibling {
                sibling_id: SECOND_ID.to_string()
            }
        );

        let children: MaterializeGithubNotificationInput = serde_json::from_value(json!({
            "rootId": GITHUB_NOTIFICATIONS_ROOT_ID,
            "snapshot": github_snapshot("42"),
            "target": {
                "kind": "children",
                "nodes": [{
                    "title": "first",
                    "children": [{ "title": "nested" }]
                }]
            }
        }))
        .expect("children target");
        assert_eq!(
            children.target,
            MaterializeGithubNotificationTarget::Children {
                nodes: vec![ImportNode {
                    title: "first".to_string(),
                    note: None,
                    marker_kind: NoteMarkerKind::Bullet,
                    children: vec![ImportNode {
                        title: "nested".to_string(),
                        note: None,
                        marker_kind: NoteMarkerKind::Bullet,
                        children: vec![]
                    }]
                }]
            }
        );
        children.validate().expect("valid children target");
        assert_eq!(
            serde_json::to_value(&children).expect("serialize children target"),
            json!({
                "rootId": GITHUB_NOTIFICATIONS_ROOT_ID,
                "snapshot": github_snapshot("42"),
                "target": {
                    "kind": "children",
                    "nodes": [{
                        "title": "first",
                        "note": null,
                        "markerKind": "bullet",
                        "children": [{
                            "title": "nested",
                            "note": null,
                            "markerKind": "bullet",
                            "children": []
                        }]
                    }]
                }
            })
        );
        assert!(
            MaterializeGithubNotificationInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                snapshot: github_snapshot("42"),
                target: MaterializeGithubNotificationTarget::Children { nodes: vec![] }
            }
            .validate()
            .is_err(),
            "an empty children import must be rejected"
        );

        for target in [
            json!({ "kind": "unknown", "nodes": [{ "title": "x" }] }),
            json!({ "kind": "children", "nodes": [], "siblingId": SECOND_ID }),
            json!({ "kind": "sibling", "siblingId": SECOND_ID, "nodes": [] }),
            json!({
                "kind": "children",
                "nodes": [{ "title": "x", "unexpected": true }]
            }),
            json!({
                "kind": "children",
                "nodes": [{
                    "title": "x",
                    "children": [{ "title": "nested", "unexpected": true }]
                }]
            }),
        ] {
            assert!(
                serde_json::from_value::<MaterializeGithubNotificationInput>(json!({
                    "rootId": GITHUB_NOTIFICATIONS_ROOT_ID,
                    "snapshot": github_snapshot("42"),
                    "target": target
                }))
                .is_err(),
                "ambiguous or unknown target must be rejected"
            );
        }
    }

    #[test]
    fn github_inputs_reject_oversized_metadata_and_aggregate_batches() {
        let mut oversized_key = github_snapshot("42");
        oversized_key.notification_key = "x".repeat(MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES + 1);
        assert!(oversized_key.validate().is_err());

        let mut oversized_url = github_snapshot("42");
        oversized_url.url = format!(
            "https://example.com/{}",
            "x".repeat(MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES + 1)
        );
        assert!(oversized_url.validate().is_err());

        let mut oversized_timestamp = github_snapshot("42");
        oversized_timestamp.updated_at = format!("2026-07-21T00:00:00.{}Z", "0".repeat(100_001));
        assert!(oversized_timestamp.validate().is_err());

        let mut aggregate = Vec::new();
        for index in 0..100 {
            let mut snapshot = github_snapshot(&index.to_string());
            snapshot.title = "t".repeat(MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES);
            snapshot.note = "n".repeat(MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES);
            aggregate.push(snapshot);
        }
        assert!(RefreshGithubNotificationsInput {
            root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
            notifications: aggregate,
        }
        .validate()
        .is_err());

        assert!(RefreshGithubNotificationsInput {
            root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
            notifications: (0..=MAX_BATCH_NODE_IDS)
                .map(|index| github_snapshot(&index.to_string()))
                .collect(),
        }
        .validate()
        .is_err());

        assert!(MarkGithubNotificationReadInput {
            root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
            notification_key: "x".repeat(MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES + 1),
            updated_at: "2026-07-21T00:00:00Z".to_string(),
        }
        .validate()
        .is_err());
    }

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
    fn import_notes_markdown_input_rejects_unknown_fields_and_invalid_values() {
        let valid = json!({
            "sourcePath": "/incoming/export.md",
            "parentId": NODE_ID,
            "afterId": SECOND_ID,
        });
        let input: ImportNotesMarkdownInput =
            serde_json::from_value(valid).expect("valid input deserializes");
        assert_eq!(input.parent_id.as_deref(), Some(NODE_ID));
        assert_eq!(input.after_id.as_deref(), Some(SECOND_ID));
        assert!(input.validate().is_ok());

        let null_input: ImportNotesMarkdownInput = serde_json::from_value(json!({
            "sourcePath": "/incoming/export.md",
            "parentId": null,
            "afterId": null,
        }))
        .expect("valid null placement deserializes");
        assert!(null_input.validate().is_ok());

        for value in [
            json!({"sourcePath": " ", "parentId": null, "afterId": null}),
            json!({"sourcePath": "/incoming/export.md", "parentId": "not-a-uuid", "afterId": null}),
            json!({"sourcePath": "/incoming/export.md", "parentId": null, "afterId": "11111111-1111-3111-8111-111111111111"}),
        ] {
            let input: ImportNotesMarkdownInput =
                serde_json::from_value(value).expect("shape is valid");
            assert!(input.validate().is_err());
        }

        for value in [
            json!({"sourcePath": "/incoming/export.md", "parentId": null}),
            json!({"sourcePath": "/incoming/export.md", "parentId": null, "afterId": null, "unexpected": true}),
            json!({"sourcePath": 7, "parentId": null, "afterId": null}),
            json!({"sourcePath": "/incoming/export.md", "parentId": 7, "afterId": null}),
            json!({"sourcePath": "/incoming/export.md", "parentId": null, "afterId": false}),
        ] {
            assert!(serde_json::from_value::<ImportNotesMarkdownInput>(value).is_err());
        }
    }

    #[test]
    fn update_node_input_requires_an_image_offset() {
        assert!(serde_json::from_value::<UpdateNodeInput>(json!({
            "id": NODE_ID,
            "title": "A😀B",
            "note": ""
        }))
        .is_err());
    }

    #[test]
    fn image_offset_rejects_a_split_surrogate() {
        assert!(
            crate::notes::schema::validate_image_offset_utf16("A😀B", NoteNodeKind::Image, 2,)
                .is_err()
        );
        assert!(
            crate::notes::schema::validate_image_offset_utf16("A😀B", NoteNodeKind::Image, 3,)
                .is_ok()
        );
    }

    #[test]
    fn path_attachment_batch_deserializes_camel_case_and_rejects_unknown_fields() {
        let input: ImportAttachmentPathBatchInput = serde_json::from_value(json!({
            "nodeId": NODE_ID,
            "attachments": [{
                "id": SECOND_ID,
                "sourcePath": "/incoming/image.png"
            }],
            "initialMaxDisplayWidth": 480
        }))
        .expect("path batch input");
        assert_eq!(input.node_id, NODE_ID);
        assert_eq!(input.attachments[0].id, SECOND_ID);
        assert_eq!(input.attachments[0].source_path, "/incoming/image.png");
        assert_eq!(input.initial_max_display_width, 480);

        assert!(
            serde_json::from_value::<ImportAttachmentPathBatchInput>(json!({
                "nodeId": NODE_ID,
                "attachments": [{
                    "id": SECOND_ID,
                    "sourcePath": "/incoming/image.png",
                    "unexpected": true
                }],
                "initialMaxDisplayWidth": 480
            }))
            .is_err()
        );
    }

    #[test]
    fn image_node_path_batch_deserializes_the_shared_anchor_and_ordered_ids() {
        let input: ImportImageNodePathsInput = serde_json::from_value(json!({
            "parentId": NODE_ID,
            "afterId": null,
            "items": [
                {
                    "nodeId": SECOND_ID,
                    "attachmentId": THIRD_ID,
                    "sourcePath": "/incoming/first.png"
                }
            ],
            "initialMaxDisplayWidth": 480
        }))
        .expect("image node path batch input");

        assert_eq!(input.parent_id.as_deref(), Some(NODE_ID));
        assert_eq!(input.after_id, None);
        assert_eq!(input.items[0].node_id, SECOND_ID);
        assert_eq!(input.items[0].attachment_id, THIRD_ID);
        assert_eq!(input.items[0].source_path, "/incoming/first.png");
        assert_eq!(input.initial_max_display_width, 480);

        assert!(serde_json::from_value::<ImportImageNodePathsInput>(json!({
            "parentId": null,
            "afterId": null,
            "items": [{
                "nodeId": SECOND_ID,
                "attachmentId": THIRD_ID,
                "sourcePath": "/incoming/first.png",
                "unexpected": true
            }],
            "initialMaxDisplayWidth": 480
        }))
        .is_err());
    }

    fn image_node_path_batch_wire_input() -> serde_json::Value {
        json!({
            "parentId": null,
            "afterId": null,
            "items": [{
                "nodeId": SECOND_ID,
                "attachmentId": THIRD_ID,
                "sourcePath": "/incoming/first.png"
            }],
            "initialMaxDisplayWidth": 480
        })
    }

    #[test]
    fn image_node_path_batch_accepts_explicit_null_anchor_keys() {
        let input: ImportImageNodePathsInput =
            serde_json::from_value(image_node_path_batch_wire_input())
                .expect("explicit null image node anchors");

        assert_eq!(input.parent_id, None);
        assert_eq!(input.after_id, None);
    }

    #[test]
    fn image_node_path_batch_requires_parent_id_key() {
        let mut input = image_node_path_batch_wire_input();
        input
            .as_object_mut()
            .expect("path batch object")
            .remove("parentId")
            .expect("remove parentId");

        let error = serde_json::from_value::<ImportImageNodePathsInput>(input)
            .expect_err("missing parentId");

        assert!(
            error.to_string().contains("missing field `parentId`"),
            "{error}"
        );
    }

    #[test]
    fn image_node_path_batch_requires_after_id_key() {
        let mut input = image_node_path_batch_wire_input();
        input
            .as_object_mut()
            .expect("path batch object")
            .remove("afterId")
            .expect("remove afterId");

        let error = serde_json::from_value::<ImportImageNodePathsInput>(input)
            .expect_err("missing afterId");

        assert!(
            error.to_string().contains("missing field `afterId`"),
            "{error}"
        );
    }

    #[test]
    fn image_node_batch_rejects_ids_shared_between_nodes_and_attachments() {
        let same_item = ImportImageNodePathsInput {
            request_id: None,
            parent_id: None,
            after_id: None,
            items: vec![super::ImportImageNodePathItem {
                node_id: SECOND_ID.to_string(),
                attachment_id: SECOND_ID.to_string(),
                source_path: "/incoming/first.png".to_string(),
            }],
            initial_max_display_width: 480,
        };
        let same_item_error = same_item.validate().expect_err("same-item ID overlap");
        assert!(
            same_item_error.contains("both a node and attachment ID"),
            "{same_item_error}"
        );

        let cross_item = ImportImageNodePathsInput {
            request_id: None,
            parent_id: None,
            after_id: None,
            items: vec![
                super::ImportImageNodePathItem {
                    node_id: SECOND_ID.to_string(),
                    attachment_id: THIRD_ID.to_string(),
                    source_path: "/incoming/first.png".to_string(),
                },
                super::ImportImageNodePathItem {
                    node_id: THIRD_ID.to_string(),
                    attachment_id: NODE_ID.to_string(),
                    source_path: "/incoming/second.png".to_string(),
                },
            ],
            initial_max_display_width: 480,
        };
        let cross_item_error = cross_item.validate().expect_err("cross-item ID overlap");
        assert!(
            cross_item_error.contains("both a node and attachment ID"),
            "{cross_item_error}"
        );
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
    fn apply_batch_input_deserializes_the_exact_camel_case_wire_shapes() {
        let complete: ApplyBatchInput = serde_json::from_value(json!({
            "nodeIds": [NODE_ID, SECOND_ID],
            "op": "complete",
            "completed": true
        }))
        .expect("complete batch input");
        assert_eq!(complete.node_ids, vec![NODE_ID, SECOND_ID]);
        assert_eq!(complete.op, BatchOp::Complete { completed: true });

        let delete: ApplyBatchInput = serde_json::from_value(json!({
            "nodeIds": [NODE_ID],
            "op": "delete"
        }))
        .expect("delete batch input");
        assert_eq!(delete.op, BatchOp::Delete);

        let move_op: ApplyBatchInput = serde_json::from_value(json!({
            "nodeIds": [SECOND_ID, THIRD_ID],
            "op": "move",
            "parentId": NODE_ID,
            "afterId": null
        }))
        .expect("move batch input");
        assert_eq!(
            move_op.op,
            BatchOp::Move {
                parent_id: Some(NODE_ID.to_string()),
                after_id: None,
                before_id: None,
            }
        );

        let move_before: ApplyBatchInput = serde_json::from_value(json!({
            "nodeIds": [SECOND_ID, THIRD_ID],
            "op": "move",
            "parentId": null,
            "afterId": null,
            "beforeId": NODE_ID
        }))
        .expect("before-anchored move batch input");
        assert_eq!(
            move_before.op,
            BatchOp::Move {
                parent_id: None,
                after_id: None,
                before_id: Some(NODE_ID.to_string()),
            }
        );

        let indent: ApplyBatchInput = serde_json::from_value(json!({
            "nodeIds": [NODE_ID],
            "op": "indent"
        }))
        .expect("indent batch input");
        assert_eq!(indent.op, BatchOp::Indent);

        let outdent: ApplyBatchInput = serde_json::from_value(json!({
            "nodeIds": [NODE_ID],
            "op": "outdent"
        }))
        .expect("outdent batch input");
        assert_eq!(outdent.op, BatchOp::Outdent);

        let duplicate: ApplyBatchInput = serde_json::from_value(json!({
            "nodeIds": [NODE_ID, SECOND_ID],
            "op": "duplicate"
        }))
        .expect("duplicate batch input");
        assert_eq!(duplicate.node_ids, vec![NODE_ID, SECOND_ID]);
        assert_eq!(duplicate.op, BatchOp::Duplicate);

        let add_tag: ApplyBatchInput = serde_json::from_value(json!({
            "nodeIds": [NODE_ID],
            "op": "addTag",
            "tag": {
                "prefix": "#",
                "normalizedTag": "roadmap",
                "displayTag": "Roadmap"
            }
        }))
        .expect("add-tag batch input");
        assert_eq!(
            add_tag.op,
            BatchOp::AddTag {
                tag: NoteSearchTag {
                    prefix: NoteTagPrefix::Hash,
                    normalized_tag: "roadmap".to_string(),
                    display_tag: "Roadmap".to_string(),
                }
            }
        );

        let remove_tag: ApplyBatchInput = serde_json::from_value(json!({
            "nodeIds": [SECOND_ID],
            "op": "removeTag",
            "tag": {
                "prefix": "@",
                "normalizedTag": "minji"
            }
        }))
        .expect("remove-tag batch input");
        assert_eq!(
            remove_tag.op,
            BatchOp::RemoveTag {
                tag: NoteTagFilter {
                    prefix: NoteTagPrefix::Mention,
                    normalized_tag: "minji".to_string(),
                }
            }
        );
    }

    #[test]
    fn apply_batch_input_validation_rejects_empty_malformed_and_oversized_selections() {
        let empty = ApplyBatchInput {
            node_ids: Vec::new(),
            op: BatchOp::Delete,
        };
        assert_eq!(
            empty.validate().expect_err("empty selection"),
            "A batch operation requires at least one node."
        );

        let malformed = ApplyBatchInput {
            node_ids: vec!["not-a-uuid".to_string()],
            op: BatchOp::Delete,
        };
        assert!(malformed.validate().is_err());

        let bad_parent = ApplyBatchInput {
            node_ids: vec![NODE_ID.to_string()],
            op: BatchOp::Move {
                parent_id: Some("not-a-uuid".to_string()),
                after_id: None,
                before_id: None,
            },
        };
        assert!(bad_parent.validate().is_err());

        let bad_before = ApplyBatchInput {
            node_ids: vec![NODE_ID.to_string()],
            op: BatchOp::Move {
                parent_id: None,
                after_id: None,
                before_id: Some("not-a-uuid".to_string()),
            },
        };
        assert!(bad_before.validate().is_err());

        let conflicting_anchors = ApplyBatchInput {
            node_ids: vec![NODE_ID.to_string()],
            op: BatchOp::Move {
                parent_id: None,
                after_id: Some(SECOND_ID.to_string()),
                before_id: Some(THIRD_ID.to_string()),
            },
        };
        assert_eq!(
            conflicting_anchors
                .validate()
                .expect_err("mutually exclusive move anchors"),
            "A batch move cannot specify both afterId and beforeId."
        );

        let maximum_ids = (0..10_000)
            .map(|index| format!("00000000-0000-4000-8000-{index:012x}"))
            .collect::<Vec<_>>();
        let maximum = ApplyBatchInput {
            node_ids: maximum_ids.clone(),
            op: BatchOp::Delete,
        };
        assert!(maximum.validate().is_ok());

        let oversized = ApplyBatchInput {
            node_ids: maximum_ids
                .into_iter()
                .chain(["00000000-0000-4000-8000-000000002710".to_string()])
                .collect(),
            op: BatchOp::Delete,
        };
        assert_eq!(
            oversized.validate().expect_err("10,001 submitted node ids"),
            "A batch operation can contain at most 10,000 node IDs."
        );
    }

    #[test]
    fn apply_batch_input_deserialization_rejects_empty_submissions() {
        let error = serde_json::from_value::<ApplyBatchInput>(json!({
            "nodeIds": [],
            "op": "delete"
        }))
        .expect_err("empty submitted selection");

        assert!(error
            .to_string()
            .contains("A batch operation requires at least one node."));
    }

    #[test]
    fn apply_batch_move_requires_nullable_parent_and_after_fields_to_be_present() {
        for value in [
            json!({
                "nodeIds": [NODE_ID],
                "op": "move",
                "afterId": null
            }),
            json!({
                "nodeIds": [NODE_ID],
                "op": "move",
                "parentId": null
            }),
        ] {
            assert!(
                serde_json::from_value::<ApplyBatchInput>(value).is_err(),
                "missing required-nullable move fields must not default to null"
            );
        }

        let explicit_nulls = serde_json::from_value::<ApplyBatchInput>(json!({
            "nodeIds": [NODE_ID],
            "op": "move",
            "parentId": null,
            "afterId": null
        }))
        .expect("explicit null move fields remain valid");
        assert_eq!(
            explicit_nulls.op,
            BatchOp::Move {
                parent_id: None,
                after_id: None,
                before_id: None,
            }
        );
    }

    #[test]
    fn apply_batch_input_deduplicates_ids_without_reordering() {
        let input: ApplyBatchInput = serde_json::from_value(json!({
            "nodeIds": [SECOND_ID, NODE_ID, SECOND_ID, THIRD_ID, NODE_ID],
            "op": "delete"
        }))
        .expect("deduplicated batch input");

        assert_eq!(input.node_ids, vec![SECOND_ID, NODE_ID, THIRD_ID]);

        let mut submitted_ids = (0..10_000)
            .map(|index| format!("00000000-0000-4000-8000-{index:012x}"))
            .collect::<Vec<_>>();
        submitted_ids.push(submitted_ids[0].clone());
        let error = serde_json::from_value::<ApplyBatchInput>(json!({
            "nodeIds": submitted_ids,
            "op": "delete"
        }))
        .expect_err("10,001 submitted ids must reject before deduplication");
        assert!(error.to_string().contains("at most 10,000 node IDs"));
    }

    #[test]
    fn apply_batch_input_validates_canonical_tags() {
        for value in [
            json!({
                "nodeIds": [NODE_ID],
                "op": "addTag",
                "tag": {
                    "prefix": "#",
                    "normalizedTag": "#Roadmap",
                    "displayTag": "Roadmap"
                }
            }),
            json!({
                "nodeIds": [NODE_ID],
                "op": "removeTag",
                "tag": {
                    "prefix": "@",
                    "normalizedTag": "Minji"
                }
            }),
        ] {
            let input: ApplyBatchInput =
                serde_json::from_value(value).expect("typed batch tag input");
            assert_eq!(
                input.validate().expect_err("noncanonical batch tag"),
                "Structured Notes search tag normalizedTag must be a canonical tag body."
            );
        }
    }

    #[test]
    fn apply_batch_input_rejects_unknown_fields() {
        assert!(serde_json::from_value::<ApplyBatchInput>(json!({
            "nodeIds": [NODE_ID],
            "op": "complete",
            "completed": true,
            "unexpected": true
        }))
        .is_err());

        for value in [
            json!({
                "nodeIds": [NODE_ID],
                "op": "addTag",
                "tag": {
                    "prefix": "#",
                    "normalizedTag": "roadmap",
                    "displayTag": "Roadmap",
                    "unexpected": true
                }
            }),
            json!({
                "nodeIds": [NODE_ID],
                "op": "removeTag",
                "tag": {
                    "prefix": "@",
                    "normalizedTag": "minji",
                    "unexpected": true
                }
            }),
        ] {
            assert!(
                serde_json::from_value::<ApplyBatchInput>(value).is_err(),
                "nested batch tag fields must be exact"
            );
        }
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
    fn note_node_kind_is_required_and_uses_the_text_image_wire_contract() {
        let mut missing_kind = serde_json::to_value(note_node()).expect("serialize node fixture");
        missing_kind
            .as_object_mut()
            .expect("node object")
            .remove("nodeKind");
        assert!(serde_json::from_value::<NoteNode>(missing_kind.clone()).is_err());

        for kind in ["text", "image"] {
            let mut value = missing_kind.clone();
            value
                .as_object_mut()
                .expect("node object")
                .insert("nodeKind".to_string(), json!(kind));
            let node: NoteNode = serde_json::from_value(value).expect("valid node kind");
            assert_eq!(
                serde_json::to_value(node).expect("serialize typed node")["nodeKind"],
                json!(kind)
            );
        }

        let mut unknown_kind = missing_kind;
        unknown_kind
            .as_object_mut()
            .expect("node object")
            .insert("nodeKind".to_string(), json!("video"));
        assert!(serde_json::from_value::<NoteNode>(unknown_kind).is_err());
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
    fn notes_search_result_uses_the_complete_camel_case_wire_shape() {
        let result = NoteSearchResult {
            node_id: NODE_ID.to_string(),
            node_kind: NoteNodeKind::Image,
            title: "Target".to_string(),
            image_offset_utf16: 0,
            attachment_name: Some("target.png".to_string()),
            display_label: "Target".to_string(),
            parent_trail: vec!["Page".to_string(), "Section".to_string()],
            parent_trail_kinds: vec![NoteNodeKind::Image, NoteNodeKind::Text],
            matched_field: NoteSearchMatchedField::Note,
        };

        assert_eq!(
            serde_json::to_value(result).expect("search result"),
            json!({
                "nodeId": NODE_ID,
                "nodeKind": "image",
                "title": "Target",
                "imageOffsetUtf16": 0,
                "attachmentName": "target.png",
                "displayLabel": "Target",
                "parentTrail": ["Page", "Section"],
                "parentTrailKinds": ["image", "text"],
                "matchedField": "note"
            })
        );
    }

    #[test]
    fn history_contracts_use_exact_camel_case_wire_shapes() {
        let context: NotesHistoryContext = serde_json::from_value(json!({
            "sessionId": NODE_ID,
            "historyEpoch": THIRD_ID,
            "entryId": SECOND_ID,
            "commandKind": "updateText"
        }))
        .expect("history context");
        assert_eq!(context.session_id, NODE_ID);
        assert_eq!(context.entry_id, SECOND_ID);
        assert_eq!(context.command_kind, "updateText");

        let replay = NotesHistoryReplayOutcome::Applied {
            workspace: NotesWorkspace {
                nodes: Vec::new(),
                attachments_by_node_id: std::collections::BTreeMap::new(),
            },
            replayed_entry_id: SECOND_ID.to_string(),
            state: history_state(),
        };
        assert_eq!(
            serde_json::to_value(replay).expect("history replay result"),
            json!({
                "workspace": { "nodes": [], "attachmentsByNodeId": {} },
                "kind": "applied",
                "replayedEntryId": SECOND_ID,
                "canUndo": true,
                "canRedo": false,
                "historyEpoch": THIRD_ID,
                "nextUndoEntryId": SECOND_ID,
                "nextRedoEntryId": null,
                "prunedEntryIds": []
            })
        );

        let mutation = NotesMutationResult {
            workspace: NotesWorkspace {
                nodes: Vec::new(),
                attachments_by_node_id: std::collections::BTreeMap::new(),
            },
            history_entry_id: Some(SECOND_ID.to_string()),
            state: history_state(),
            changed_nodes: None,
            removed_node_ids: None,
            changed_attachments: None,
            imported_root_ids: None,
            duplicated_root_ids: None,
        };
        assert_eq!(
            serde_json::to_value(mutation).expect("mutation result"),
            json!({
                "workspace": { "nodes": [], "attachmentsByNodeId": {} },
                "historyEntryId": SECOND_ID,
                "canUndo": true,
                "canRedo": false,
                "historyEpoch": THIRD_ID,
                "nextUndoEntryId": SECOND_ID,
                "nextRedoEntryId": null,
                "prunedEntryIds": []
            })
        );

        let duplicated = NotesMutationResult {
            workspace: NotesWorkspace {
                nodes: Vec::new(),
                attachments_by_node_id: std::collections::BTreeMap::new(),
            },
            history_entry_id: Some(SECOND_ID.to_string()),
            state: history_state(),
            changed_nodes: None,
            removed_node_ids: None,
            changed_attachments: None,
            imported_root_ids: None,
            duplicated_root_ids: Some(vec![NODE_ID.to_string(), THIRD_ID.to_string()]),
        };
        assert_eq!(
            serde_json::to_value(duplicated).expect("duplicate mutation result"),
            json!({
                "workspace": { "nodes": [], "attachmentsByNodeId": {} },
                "historyEntryId": SECOND_ID,
                "canUndo": true,
                "canRedo": false,
                "historyEpoch": THIRD_ID,
                "nextUndoEntryId": SECOND_ID,
                "nextRedoEntryId": null,
                "prunedEntryIds": [],
                "duplicatedRootIds": [NODE_ID, THIRD_ID]
            })
        );
    }

    #[test]
    fn delete_nodes_deleted_outcome_uses_the_normal_mutation_wire_shape() {
        let mutation = NotesMutationResult {
            workspace: NotesWorkspace {
                nodes: Vec::new(),
                attachments_by_node_id: std::collections::BTreeMap::new(),
            },
            history_entry_id: None,
            state: history_state(),
            changed_nodes: None,
            removed_node_ids: None,
            changed_attachments: None,
            imported_root_ids: None,
            duplicated_root_ids: None,
        };
        assert_eq!(
            serde_json::to_value(DeleteNodesOutcome::Deleted(mutation)).expect("deleted outcome"),
            json!({
                "workspace": { "nodes": [], "attachmentsByNodeId": {} },
                "historyEntryId": null,
                "canUndo": true,
                "canRedo": false,
                "historyEpoch": THIRD_ID,
                "nextUndoEntryId": SECOND_ID,
                "nextRedoEntryId": null,
                "prunedEntryIds": []
            })
        );
    }

    #[test]
    fn mutation_delta_fields_use_the_exact_optional_camel_case_wire_shape() {
        let node = note_node();
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
        let mutation = NotesMutationResult {
            workspace: NotesWorkspace {
                nodes: vec![node.clone()],
                attachments_by_node_id: std::collections::BTreeMap::new(),
            },
            history_entry_id: None,
            state: history_state(),
            changed_nodes: Some(vec![node]),
            removed_node_ids: Some(vec![THIRD_ID.to_string()]),
            changed_attachments: Some(vec![attachment]),
            imported_root_ids: None,
            duplicated_root_ids: None,
        };

        assert_eq!(
            serde_json::to_value(mutation).expect("mutation delta result"),
            json!({
                "workspace": {
                    "nodes": [{
                        "id": NODE_ID,
                        "nodeKind": "text",
                        "markerKind": "bullet",
                        "parentId": null,
                        "sortKey": 1024,
                        "title": "Root",
                        "note": "",
                        "imageOffsetUtf16": 0,
                        "markdownImageWidth": null,
                        "layoutMode": "bullets",
                        "isCollapsed": false,
                        "isStarred": true,
                        "completedAt": null,
                        "createdAt": "2026-07-11T00:00:00.000Z",
                        "updatedAt": "2026-07-11T00:00:01.000Z",
                        "deletedAt": null,
                        "archivedAt": null,
                        "archiveRootId": null
                    }],
                    "attachmentsByNodeId": {}
                },
                "historyEntryId": null,
                "canUndo": true,
                "canRedo": false,
                "historyEpoch": THIRD_ID,
                "nextUndoEntryId": SECOND_ID,
                "nextRedoEntryId": null,
                "prunedEntryIds": [],
                "changedNodes": [{
                    "id": NODE_ID,
                    "nodeKind": "text",
                    "markerKind": "bullet",
                    "parentId": null,
                    "sortKey": 1024,
                    "title": "Root",
                    "note": "",
                    "imageOffsetUtf16": 0,
                    "markdownImageWidth": null,
                    "layoutMode": "bullets",
                    "isCollapsed": false,
                    "isStarred": true,
                    "completedAt": null,
                    "createdAt": "2026-07-11T00:00:00.000Z",
                    "updatedAt": "2026-07-11T00:00:01.000Z",
                    "deletedAt": null,
                    "archivedAt": null,
                    "archiveRootId": null
                }],
                "removedNodeIds": [THIRD_ID],
                "changedAttachments": [{
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
