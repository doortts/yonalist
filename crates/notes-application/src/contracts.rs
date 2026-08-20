use notes_core::{NoteImage, NoteMarkerKind, NoteNode, NoteNodeKind};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UnusedAssetsReport {
    pub count: u32,
    #[ts(type = "number")]
    pub total_bytes: u64,
    pub purged: bool,
}

/// What a rebuild from the folder did, in the two numbers a person can hold
/// against their own folder: how many documents it read, and how many it could
/// not. The second one is not folded into the first — a note missing because
/// this build could not read its file has no other signal.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VaultRebuildReport {
    pub documents: u32,
    pub unreadable: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HistoryState {
    pub can_undo: bool,
    pub can_redo: bool,
    pub undo_depth: u32,
    pub redo_depth: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NoteView {
    pub id: String,
    pub parent_id: Option<String>,
    #[ts(type = "number")]
    pub sort_key: i64,
    pub kind: IpcNodeKind,
    pub image: Option<ImageView>,
    pub text: String,
    pub note: String,
    pub marker: IpcMarkerKind,
    pub collapsed: bool,
    pub completed: bool,
    pub starred: bool,
    pub deleted: bool,
}

impl From<NoteNode> for NoteView {
    fn from(node: NoteNode) -> Self {
        Self {
            id: node.id().to_string(),
            parent_id: node.parent_id().map(ToString::to_string),
            sort_key: node.sort_key(),
            kind: node.kind().into(),
            image: node.image().map(ImageView::from),
            text: node.text().to_owned(),
            note: node.note().to_owned(),
            marker: node.marker().into(),
            collapsed: node.is_collapsed(),
            completed: node.is_completed(),
            starred: node.is_starred(),
            deleted: node.is_deleted(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageView {
    pub content_hash: String,
    pub original_name: String,
    pub mime_type: String,
    #[ts(type = "number")]
    pub byte_length: u64,
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub display_width: u32,
}

impl From<&NoteImage> for ImageView {
    fn from(image: &NoteImage) -> Self {
        Self {
            content_hash: image.content_hash().to_owned(),
            original_name: image.original_name().to_owned(),
            mime_type: image.mime_type().to_owned(),
            byte_length: image.byte_length(),
            pixel_width: image.pixel_width(),
            pixel_height: image.pixel_height(),
            display_width: image.display_width(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum IpcMarkerKind {
    Bullet,
    Todo,
    Ordered { start: i64 },
}

impl From<NoteMarkerKind> for IpcMarkerKind {
    fn from(marker: NoteMarkerKind) -> Self {
        match marker {
            NoteMarkerKind::Bullet => Self::Bullet,
            NoteMarkerKind::Todo => Self::Todo,
            NoteMarkerKind::Ordered { start } => Self::Ordered { start },
        }
    }
}

impl From<IpcMarkerKind> for NoteMarkerKind {
    fn from(marker: IpcMarkerKind) -> Self {
        match marker {
            IpcMarkerKind::Bullet => Self::Bullet,
            IpcMarkerKind::Todo => Self::Todo,
            IpcMarkerKind::Ordered { start } => Self::Ordered { start },
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum IpcNodeKind {
    Page,
    Bullet,
    Image,
}

impl From<NoteNodeKind> for IpcNodeKind {
    fn from(kind: NoteNodeKind) -> Self {
        match kind {
            NoteNodeKind::Page => Self::Page,
            NoteNodeKind::Bullet => Self::Bullet,
            NoteNodeKind::Image => Self::Image,
        }
    }
}

/// An image an import references by hash. Same fields as `ImageView` without the
/// derived path, which the domain rebuilds from the hash and the MIME type.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IpcImportImage {
    pub content_hash: String,
    pub original_name: String,
    pub mime_type: String,
    #[ts(type = "number")]
    pub byte_length: u64,
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub display_width: u32,
}

/// The fields past `text` all default, so a plain text paste keeps sending three
/// of them and a rich paste fills the rest in the same command.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IpcImportNode {
    pub id: String,
    pub parent_id: String,
    pub text: String,
    #[serde(default)]
    #[ts(optional)]
    pub note: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub marker: Option<IpcMarkerKind>,
    #[serde(default)]
    #[ts(optional)]
    pub completed: Option<bool>,
    #[serde(default)]
    #[ts(optional)]
    pub collapsed: Option<bool>,
    #[serde(default)]
    #[ts(optional)]
    pub starred: Option<bool>,
    #[serde(default)]
    #[ts(optional)]
    pub image: Option<IpcImportImage>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IpcNodeMove {
    pub id: String,
    pub parent_id: String,
    pub before_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IpcNodeDuplicate {
    pub id: String,
    pub new_id: String,
    pub parent_id: String,
    pub before_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind")]
#[ts(export)]
pub enum IpcNotesCommand {
    CreateNode {
        id: String,
        parent_id: String,
        before_id: Option<String>,
        text: String,
    },
    ImportNodes {
        parent_id: String,
        before_id: Option<String>,
        nodes: Vec<IpcImportNode>,
    },
    UpdateText {
        id: String,
        text: String,
    },
    UpdateNote {
        id: String,
        note: String,
    },
    SplitNode {
        id: String,
        new_id: String,
        parent_id: String,
        before_id: Option<String>,
        prefix: String,
        suffix: String,
    },
    MergeNodeBackward {
        id: String,
        previous_id: String,
        previous_text: String,
        current_text: String,
    },
    MergeNodeIntoParent {
        id: String,
        parent_id: String,
        parent_text: String,
        current_text: String,
    },
    RemoveEmptyNode {
        id: String,
    },
    MoveNode {
        id: String,
        parent_id: String,
        before_id: Option<String>,
    },
    MoveNodes {
        moves: Vec<IpcNodeMove>,
    },
    Indent {
        id: String,
        new_parent_id: String,
    },
    Outdent {
        id: String,
        new_parent_id: String,
        before_id: Option<String>,
    },
    Duplicate {
        id: String,
        new_id: String,
        parent_id: String,
        before_id: Option<String>,
    },
    DuplicateNodes {
        duplicates: Vec<IpcNodeDuplicate>,
    },
    SetCompleted {
        id: String,
        completed: bool,
    },
    SetCompletedMany {
        ids: Vec<String>,
        completed: bool,
    },
    /// One press of the completion chord. The server decides which of its three
    /// moves this is; the client only says which row was pressed.
    CycleCompleted {
        id: String,
    },
    SetStarred {
        id: String,
        starred: bool,
    },
    SetCollapsed {
        id: String,
        collapsed: bool,
    },
    SetMarker {
        id: String,
        marker: IpcMarkerKind,
    },
    ResizeImage {
        id: String,
        display_width: u32,
    },
    DeleteSubtree {
        id: String,
    },
    DeleteSubtrees {
        ids: Vec<String>,
    },
    RestoreSubtree {
        id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CommandEnvelope {
    pub session_id: String,
    pub request_id: String,
    #[ts(type = "number")]
    pub base_revision: u64,
    pub history_group: Option<String>,
    pub command: IpcNotesCommand,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageImportItem {
    pub node_id: String,
    pub original_name: String,
    pub declared_mime_type: Option<String>,
    #[ts(type = "number")]
    pub byte_length: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageImportContext {
    pub session_id: String,
    pub request_id: String,
    #[ts(type = "number")]
    pub base_revision: u64,
    pub history_group: Option<String>,
    pub parent_id: String,
    pub before_id: Option<String>,
    pub items: Vec<ImageImportItem>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageReadRequest {
    pub session_id: String,
    pub node_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImagePathImportItem {
    pub node_id: String,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImagePathImportRequest {
    pub session_id: String,
    pub request_id: String,
    #[ts(type = "number")]
    pub base_revision: u64,
    pub history_group: Option<String>,
    pub parent_id: String,
    pub before_id: Option<String>,
    pub images: Vec<ImagePathImportItem>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageReplaceContext {
    pub session_id: String,
    pub request_id: String,
    #[ts(type = "number")]
    pub base_revision: u64,
    pub history_group: Option<String>,
    pub target_id: String,
    pub item: ImageImportItem,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageReplacePathRequest {
    pub session_id: String,
    pub request_id: String,
    #[ts(type = "number")]
    pub base_revision: u64,
    pub history_group: Option<String>,
    pub target_id: String,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageDownloadRequest {
    pub session_id: String,
    pub node_id: String,
    pub destination_path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HistoryRequest {
    pub session_id: String,
    #[ts(type = "number")]
    pub base_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MutationReceipt {
    #[ts(type = "number")]
    pub revision: u64,
    pub changed_nodes: Vec<NoteView>,
    pub deleted_ids: Vec<String>,
    pub history: HistoryState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PageSummary {
    pub id: String,
    pub title: String,
    #[ts(type = "number")]
    pub sort_key: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ViewportRequest {
    pub page_id: String,
    pub anchor_id: Option<String>,
    pub before_cursor: Option<String>,
    pub after_cursor: Option<String>,
    pub limit: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ViewportPage {
    pub page_id: String,
    pub anchor_id: Option<String>,
    pub before_cursor: Option<String>,
    pub after_cursor: Option<String>,
    /// The page's own node, which the body listing deliberately leaves out.
    /// The heading's note lives on it.
    #[serde(default)]
    #[ts(optional)]
    pub page_node: Option<NoteView>,
    pub nodes: Vec<NoteView>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForestRequest {
    pub root_ids: Vec<String>,
    pub limit: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForestSnapshot {
    #[ts(type = "number")]
    pub revision: u64,
    pub nodes: Vec<NoteView>,
    pub complete: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BootSnapshot {
    pub session_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub active_page_id: Option<String>,
    pub pages: Vec<PageSummary>,
    pub viewport: Option<ViewportPage>,
    pub history: HistoryState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SearchQuery {
    pub text: String,
    pub cursor: Option<String>,
    pub limit: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SearchHit {
    pub node: NoteView,
    pub page_id: String,
    pub snippet: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SearchPage {
    pub hits: Vec<SearchHit>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CloseOutcome {
    Flushed,
    AlreadyClosed,
}

/// What sync cannot do right now, as the window shows it. Asked for rather
/// than pushed: a watch that failed at startup does so before the window is
/// listening, so the answer has to be available to whoever asks late.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SyncStatus {
    /// Files in the folder this app looked at and could not read.
    pub refused: Vec<RefusedFile>,
    /// Why the last write into the folder failed. A write that succeeds
    /// clears it.
    pub write_error: Option<String>,
    /// Why the folder is not being watched. A watch that succeeds clears it.
    /// Kept apart from the write: a successful export saying nothing about
    /// the watch would be a lie about the one that failed.
    pub watch_error: Option<String>,
}

/// A file this app refused, and the sentence the parser gave for it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RefusedFile {
    pub path: String,
    pub reason: String,
}

/// One attachment, as the list shows it: one row per bullet rather than one
/// per file, because the user finds a picture by the note they put it in. A
/// file two pages use is two rows, each saying so.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SyncAttachment {
    /// Empty for bytes no note mentions any more — there is no bullet to go to.
    pub node_id: String,
    /// What the bullet called the file.
    pub name: String,
    #[ts(type = "number")]
    pub byte_length: i64,
    pub content_hash: String,
    pub page_id: String,
    pub page_title: String,
    /// The bullet this one sits under, empty when it sits on the page itself.
    pub parent_title: String,
    pub references: u32,
    pub trashed: bool,
    /// When the last note stopped pointing at it. The screen counts the two
    /// weeks from here; `None` means something still points at it.
    #[ts(type = "number | null")]
    pub unreferenced_at: Option<i64>,
}

/// What a merge changed, pushed to the window rather than answered to it.
/// This is the app's first event: every other change the window learns about
/// is the receipt for something it asked for, and a file arriving from another
/// device is nobody's request.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SyncChanged {
    #[ts(type = "number")]
    pub revision: u64,
    pub changed_node_ids: Vec<String>,
    pub deleted_node_ids: Vec<String>,
}

/// One defeat, complete enough for the settings screen to show it and to put
/// it back. By the time anyone looks, the file that lost is long gone — so
/// everything the screen needs lives in the row rather than being fetched.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SyncConflict {
    #[ts(type = "number")]
    pub seq: i64,
    pub node_id: String,
    /// `lww`, `same_t`, `clock_drift` or `dirty_overwrite`.
    pub reason: String,
    /// The file the dropped version arrived in, relative to the vault. Empty on
    /// a record written before this was kept.
    pub file_path: String,
    /// When the merge noticed the disagreement, which is later than either
    /// version was edited and can be much later — a file arrives when the sync
    /// client gets round to it.
    #[ts(type = "number")]
    pub recorded_at: i64,
    /// The version that stood.
    pub kept: SyncConflictSide,
    /// The version that was replaced. This is the one `conflict_loser` puts
    /// back.
    pub dropped: SyncConflictSide,
}

/// One of the two versions a conflict was between. Both sides are described the
/// same way: the screen shows them beside each other, and a reader comparing
/// them should not have to compare two shapes as well.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SyncConflictSide {
    /// What this side said, for the reader to recognise it by.
    pub text: String,
    /// When this version was edited, from the stamp it carried. Zero where the
    /// stamp cannot be read — the record is still worth showing.
    #[ts(type = "number")]
    pub edited_at_millis: i64,
    /// The four hexadecimal characters the stamp names the device by. Empty
    /// where the stamp cannot be read.
    pub device_id: String,
    /// What that device is called, when some file it wrote has said so.
    pub device_name: Option<String>,
    pub is_this_device: bool,
}

/// What the app found in the folder the user picked. Every state is accepted —
/// this only tells the screen which sentence to show, so a wrong reading costs
/// a misleading hint and nothing more. Whether the files inside are actually
/// well formed is the parser's question, not this one's.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SyncVaultFolderState {
    Empty,
    ExistingVault,
    NonEmpty,
}
