use serde::{Deserialize, Serialize};

use crate::{NodeId, NoteImage, NoteMarkerKind, NoteNode};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ImportNode {
    pub id: NodeId,
    pub parent_id: NodeId,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ImportImageNode {
    pub id: NodeId,
    pub image: NoteImage,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct NodeMove {
    pub id: NodeId,
    pub parent_id: NodeId,
    pub position: Position,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct NodeDuplicate {
    pub source_id: NodeId,
    pub new_id: NodeId,
    pub parent_id: NodeId,
    pub position: Position,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum Position {
    AtEnd,
    Before { sibling_id: NodeId },
}

impl Position {
    pub fn at_end() -> Self {
        Self::AtEnd
    }

    pub fn before(sibling_id: NodeId) -> Self {
        Self::Before { sibling_id }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum NotesCommand {
    Batch {
        commands: Vec<NotesCommand>,
    },
    CreatePage {
        id: NodeId,
        text: String,
    },
    CreateNode {
        id: NodeId,
        parent_id: NodeId,
        position: Position,
        text: String,
    },
    ImportNodes {
        parent_id: NodeId,
        position: Position,
        nodes: Vec<ImportNode>,
    },
    ImportImages {
        parent_id: NodeId,
        position: Position,
        nodes: Vec<ImportImageNode>,
    },
    UpdateText {
        id: NodeId,
        text: String,
    },
    UpdateNote {
        id: NodeId,
        note: String,
    },
    ResizeImage {
        id: NodeId,
        display_width: u32,
    },
    ReplaceImage {
        id: NodeId,
        image: NoteImage,
    },
    SplitNode {
        id: NodeId,
        new_id: NodeId,
        parent_id: NodeId,
        position: Position,
        prefix: String,
        suffix: String,
    },
    MergeNodeBackward {
        id: NodeId,
        previous_id: NodeId,
        previous_text: String,
        current_text: String,
    },
    RemoveEmptyNode {
        id: NodeId,
    },
    MoveNode {
        id: NodeId,
        parent_id: NodeId,
        position: Position,
    },
    MoveNodes {
        moves: Vec<NodeMove>,
    },
    IndentNode {
        id: NodeId,
        parent_id: NodeId,
    },
    DuplicateNode {
        source_id: NodeId,
        new_id: NodeId,
        parent_id: NodeId,
        position: Position,
    },
    DuplicateNodes {
        duplicates: Vec<NodeDuplicate>,
    },
    SetCompleted {
        id: NodeId,
        completed: bool,
    },
    SetCompletedMany {
        ids: Vec<NodeId>,
        completed: bool,
    },
    SetStarred {
        id: NodeId,
        starred: bool,
    },
    SetCollapsed {
        id: NodeId,
        collapsed: bool,
    },
    SetMarker {
        id: NodeId,
        marker: NoteMarkerKind,
    },
    DeleteSubtree {
        id: NodeId,
    },
    DeleteSubtrees {
        ids: Vec<NodeId>,
    },
    RestoreSubtree {
        id: NodeId,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TreeMutation {
    Upsert(Box<NoteNode>),
    Delete { id: NodeId },
}

impl TreeMutation {
    pub fn upsert(node: NoteNode) -> Self {
        Self::Upsert(Box::new(node))
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct DomainPatch {
    pub forward: Vec<TreeMutation>,
    pub inverse: Vec<TreeMutation>,
}
