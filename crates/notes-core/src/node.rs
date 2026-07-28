use serde::{Deserialize, Serialize};

use crate::NodeId;

pub const SORT_KEY_STEP: i64 = 1_024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteNodeKind {
    Page,
    Bullet,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteMarkerKind {
    Bullet,
    Todo,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct NoteNode {
    id: NodeId,
    parent_id: Option<NodeId>,
    sort_key: i64,
    kind: NoteNodeKind,
    text: String,
    note: String,
    marker: NoteMarkerKind,
    collapsed: bool,
    completed: bool,
    starred: bool,
    deleted: bool,
}

impl NoteNode {
    pub fn page(id: NodeId, text: impl Into<String>) -> Self {
        Self {
            id,
            parent_id: None,
            sort_key: SORT_KEY_STEP,
            kind: NoteNodeKind::Page,
            text: text.into(),
            note: String::new(),
            marker: NoteMarkerKind::Bullet,
            collapsed: false,
            completed: false,
            starred: false,
            deleted: false,
        }
    }

    pub fn child(id: NodeId, parent_id: NodeId, sort_key: i64, text: impl Into<String>) -> Self {
        Self {
            id,
            parent_id: Some(parent_id),
            sort_key,
            kind: NoteNodeKind::Bullet,
            text: text.into(),
            note: String::new(),
            marker: NoteMarkerKind::Bullet,
            collapsed: false,
            completed: false,
            starred: false,
            deleted: false,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn from_persisted(
        id: NodeId,
        parent_id: Option<NodeId>,
        sort_key: i64,
        kind: NoteNodeKind,
        text: String,
        note: String,
        marker: NoteMarkerKind,
        collapsed: bool,
        completed: bool,
        starred: bool,
        deleted: bool,
    ) -> Self {
        Self {
            id,
            parent_id,
            sort_key,
            kind,
            text,
            note,
            marker,
            collapsed,
            completed,
            starred,
            deleted,
        }
    }

    pub fn id(&self) -> &NodeId {
        &self.id
    }

    pub fn parent_id(&self) -> Option<&NodeId> {
        self.parent_id.as_ref()
    }

    pub fn sort_key(&self) -> i64 {
        self.sort_key
    }

    pub fn kind(&self) -> NoteNodeKind {
        self.kind
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn note(&self) -> &str {
        &self.note
    }

    pub fn marker(&self) -> NoteMarkerKind {
        self.marker
    }

    pub fn is_collapsed(&self) -> bool {
        self.collapsed
    }

    pub fn is_completed(&self) -> bool {
        self.completed
    }

    pub fn is_starred(&self) -> bool {
        self.starred
    }

    pub fn is_deleted(&self) -> bool {
        self.deleted
    }

    pub(crate) fn set_parent_id(&mut self, parent_id: NodeId) {
        self.parent_id = Some(parent_id);
    }

    pub(crate) fn set_sort_key(&mut self, sort_key: i64) {
        self.sort_key = sort_key;
    }

    pub(crate) fn set_text(&mut self, text: String) {
        self.text = text;
    }

    pub(crate) fn set_note(&mut self, note: String) {
        self.note = note;
    }

    pub(crate) fn set_marker(&mut self, marker: NoteMarkerKind) {
        self.marker = marker;
    }

    pub(crate) fn set_collapsed(&mut self, collapsed: bool) {
        self.collapsed = collapsed;
    }

    pub(crate) fn set_completed(&mut self, completed: bool) {
        self.completed = completed;
    }

    pub(crate) fn set_starred(&mut self, starred: bool) {
        self.starred = starred;
    }

    pub(crate) fn set_deleted(&mut self, deleted: bool) {
        self.deleted = deleted;
    }
}
