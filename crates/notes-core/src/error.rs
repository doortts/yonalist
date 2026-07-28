use thiserror::Error;

use crate::NodeId;

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum DomainError {
    #[error("node id is empty, too long, or contains a control character")]
    InvalidNodeId,
    #[error("node already exists: {0}")]
    DuplicateNode(NodeId),
    #[error("node was not found: {0}")]
    NodeNotFound(NodeId),
    #[error("parent was not found: {0}")]
    ParentNotFound(NodeId),
    #[error("sibling was not found under the requested parent: {0}")]
    SiblingNotFound(NodeId),
    #[error("page nodes cannot be moved below another node")]
    CannotMovePage,
    #[error("page nodes cannot be duplicated as bullets")]
    CannotDuplicatePage,
    #[error("page nodes cannot be split as bullets")]
    CannotSplitPage,
    #[error("page nodes cannot be removed by the empty-bullet gesture")]
    CannotRemovePage,
    #[error("node is not empty: {0}")]
    NodeNotEmpty(NodeId),
    #[error("moving {node_id} below {parent_id} would create a cycle")]
    Cycle { node_id: NodeId, parent_id: NodeId },
    #[error("tree invariant failed: {0}")]
    Invariant(String),
    #[error("sort key overflowed")]
    SortKeyOverflow,
}
