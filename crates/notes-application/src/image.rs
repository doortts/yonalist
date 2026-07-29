use std::collections::BTreeSet;
use std::path::PathBuf;

use notes_core::{NodeId, NoteImage};

use crate::StorageError;

pub const MAX_IMAGE_BATCH_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_IMAGE_BATCH_ITEMS: usize = 128;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ImageSource {
    Bytes(Vec<u8>),
    Path(PathBuf),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImageImportSource {
    pub node_id: NodeId,
    pub original_name: String,
    pub declared_mime_type: Option<String>,
    pub source: ImageSource,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublishedImage {
    pub image: NoteImage,
    pub newly_created: bool,
}

pub trait ImageAssetPort: Send + Sync {
    fn prepare(&self, sources: &[ImageImportSource]) -> Result<Vec<PublishedImage>, StorageError>;

    fn read(&self, image: &NoteImage) -> Result<Vec<u8>, StorageError>;

    fn rollback(&self, images: &[PublishedImage]);

    fn reconcile(&self, live_hashes: &BTreeSet<String>) -> Result<(), StorageError>;
}

impl<T: ImageAssetPort + ?Sized> ImageAssetPort for &T {
    fn prepare(&self, sources: &[ImageImportSource]) -> Result<Vec<PublishedImage>, StorageError> {
        (**self).prepare(sources)
    }

    fn read(&self, image: &NoteImage) -> Result<Vec<u8>, StorageError> {
        (**self).read(image)
    }

    fn rollback(&self, images: &[PublishedImage]) {
        (**self).rollback(images);
    }

    fn reconcile(&self, live_hashes: &BTreeSet<String>) -> Result<(), StorageError> {
        (**self).reconcile(live_hashes)
    }
}
