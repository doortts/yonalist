//! Notes use cases, IPC contracts, storage ports, and session history.

mod command_conversion;
mod contracts;
mod error;
mod service;
mod storage;

pub use contracts::*;
pub use error::{NotesError, NotesErrorCode};
pub use service::NotesService;
pub use storage::{StorageCommit, StorageError, StoragePort};
