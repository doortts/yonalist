use notes_core::{DomainError, DomainPatch, NodeId, NoteNode, NotesCommand, NotesTree};
use std::sync::Arc;
use thiserror::Error;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StorageCommit {
    pub revision: u64,
    pub changed_nodes: Vec<NoteNode>,
    pub deleted_ids: Vec<NodeId>,
}

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum StorageError {
    #[error("revision conflict: expected {expected}, actual {actual}")]
    RevisionConflict { expected: u64, actual: u64 },
    #[error(transparent)]
    Domain(#[from] DomainError),
    #[error("Notes storage is unavailable: {0}")]
    Unavailable(String),
    #[error("Notes storage failed: {0}")]
    Internal(String),
}

pub trait StoragePort: Send + Sync {
    fn load_command_tree(&self, command: &NotesCommand) -> Result<NotesTree, StorageError>;

    fn commit(
        &self,
        expected_revision: u64,
        patch: &DomainPatch,
    ) -> Result<StorageCommit, StorageError>;
}

impl<T: StoragePort + ?Sized> StoragePort for &T {
    fn load_command_tree(&self, command: &NotesCommand) -> Result<NotesTree, StorageError> {
        (**self).load_command_tree(command)
    }

    fn commit(
        &self,
        expected_revision: u64,
        patch: &DomainPatch,
    ) -> Result<StorageCommit, StorageError> {
        (**self).commit(expected_revision, patch)
    }
}

impl<T: StoragePort + ?Sized> StoragePort for Arc<T> {
    fn load_command_tree(&self, command: &NotesCommand) -> Result<NotesTree, StorageError> {
        (**self).load_command_tree(command)
    }

    fn commit(
        &self,
        expected_revision: u64,
        patch: &DomainPatch,
    ) -> Result<StorageCommit, StorageError> {
        (**self).commit(expected_revision, patch)
    }
}
