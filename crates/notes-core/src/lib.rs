//! Pure Notes domain rules.
//!
//! This crate has no database, IPC, platform, or UI dependencies. Commands are
//! planned as reversible patches before any side effect is allowed.

mod command;
mod error;
mod id;
mod node;
mod tree;

pub use command::{
    DomainPatch, ImportNode, NodeDuplicate, NodeMove, NotesCommand, Position, TreeMutation,
};
pub use error::DomainError;
pub use id::NodeId;
pub use node::{NoteMarkerKind, NoteNode, NoteNodeKind};
pub use tree::NotesTree;
