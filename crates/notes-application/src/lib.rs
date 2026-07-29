//! Notes use cases, IPC contracts, storage ports, and session history.

mod command_conversion;
mod contracts;
mod error;
mod image;
mod service;
mod storage;

pub use contracts::*;
pub use error::{NotesError, NotesErrorCode};
pub use image::{
    ImageAssetPort, ImageImportSource, ImageSource, MAX_IMAGE_BATCH_BYTES, MAX_IMAGE_BATCH_ITEMS,
    PublishedImage,
};
pub use service::NotesService;
pub use storage::{StorageCommit, StorageError, StoragePort};
