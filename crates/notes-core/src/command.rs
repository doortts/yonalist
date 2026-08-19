use serde::{Deserialize, Serialize};

use crate::{NodeId, NoteImage, NoteMarkerKind, NoteNode};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ImportNode {
    pub id: NodeId,
    pub parent_id: NodeId,
    pub text: String,
    pub note: String,
    pub marker: NoteMarkerKind,
    pub completed: bool,
    pub collapsed: bool,
    pub starred: bool,
    /// An imported node may reference an image asset that already exists; the
    /// bytes are never carried through the command.
    pub image: Option<NoteImage>,
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
    /// Backspace at the head of a first child: the parent takes the joined
    /// text, the row goes, and the row's own children rise into its place. One
    /// command because it is one keystroke -- spelled as three, a write landing
    /// between them tears the gesture out of its history entry and one undo
    /// answers for part of it.
    MergeNodeIntoParent {
        id: NodeId,
        parent_id: NodeId,
        parent_text: String,
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
    /// One press of the completion chord. Which of its three moves this is comes
    /// from the tree, not from the caller. `restore` is what the row's children
    /// held before the press that finished them, which only the session that saw
    /// that press knows; empty means there is nothing to hand back.
    CycleCompleted {
        id: NodeId,
        restore: Vec<(NodeId, bool)>,
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

/// The three moves one press of the completion chord can make.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompletionStage {
    /// The row is not done: finish the row itself and leave its children alone.
    Row,
    /// The row is done and something under it is not: finish its children.
    Children,
    /// The row is done and its children with it: open the row again, handing the
    /// children back what they held before.
    Back,
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
    /// Pictures a copied node cannot bring with it. A picture still waiting for
    /// its bytes reads as a node without one, so a duplicate of it would land
    /// holding nothing at all — and nothing the arriving bytes could settle.
    /// Source first, then the copy that has to be given the same picture. The
    /// mutations cannot say this: what has to be copied is not tree state,
    /// which is the whole reason the node arrives empty.
    pub carried_pictures: Vec<(NodeId, NodeId)>,
}
