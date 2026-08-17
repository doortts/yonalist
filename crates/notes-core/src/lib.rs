//! Pure Notes domain rules.
//!
//! This crate has no database, IPC, platform, or UI dependencies. Commands are
//! planned as reversible patches before any side effect is allowed.

mod command;
mod error;
mod id;
mod image;
mod node;
mod tree;

pub use command::{
    DomainPatch, ImportImageNode, ImportNode, NodeDuplicate, NodeMove, NotesCommand, Position,
    TreeMutation,
};
pub use error::DomainError;
pub use id::{HOME_ID, NodeId, YID_LENGTH, encode_yid, is_block_id, is_yid, new_yid};
pub use image::{MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MIN_IMAGE_DISPLAY_WIDTH, NoteImage};
pub use node::{MAX_FIELD_BYTES, NoteMarkerKind, NoteNode, NoteNodeKind, SORT_KEY_STEP};
pub use tree::{MAX_TREE_DEPTH, NotesTree};
