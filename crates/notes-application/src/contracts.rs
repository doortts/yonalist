use notes_core::{NoteMarkerKind, NoteNode, NoteNodeKind};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum IpcMarkerKind {
    Bullet,
    Todo,
}

impl From<NoteMarkerKind> for IpcMarkerKind {
    fn from(marker: NoteMarkerKind) -> Self {
        match marker {
            NoteMarkerKind::Bullet => Self::Bullet,
            NoteMarkerKind::Todo => Self::Todo,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum IpcNodeKind {
    Page,
    Bullet,
}

impl From<NoteNodeKind> for IpcNodeKind {
    fn from(kind: NoteNodeKind) -> Self {
        match kind {
            NoteNodeKind::Page => Self::Page,
            NoteNodeKind::Bullet => Self::Bullet,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IpcImportNode {
    pub id: String,
    pub parent_id: String,
    pub text: String,
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
    CreatePage {
        id: String,
        text: String,
    },
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
