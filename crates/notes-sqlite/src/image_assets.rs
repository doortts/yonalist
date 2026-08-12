use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use image::{GenericImageView, ImageFormat};
use notes_application::{
    ImageAssetPort, ImageImportSource, ImageSource, MAX_IMAGE_BATCH_BYTES, MAX_IMAGE_BATCH_ITEMS,
    PublishedImage, StorageError,
};
use notes_core::{DomainError, MAX_IMAGE_BYTES, MIN_IMAGE_DISPLAY_WIDTH, NoteImage};
use sha2::{Digest, Sha256};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const DEFAULT_DISPLAY_WIDTH: u32 = 320;

pub struct LocalImageAssets {
    root: PathBuf,
}

struct PreparedAsset {
    bytes: Vec<u8>,
    image: NoteImage,
}

impl LocalImageAssets {
    pub fn open(root: &Path) -> Result<Self, StorageError> {
        fs::create_dir_all(root).map_err(unavailable)?;
        let metadata = fs::symlink_metadata(root).map_err(unavailable)?;
        if is_link_or_reparse(&metadata) || !metadata.is_dir() {
            return Err(unavailable_message(
                "The Notes image directory is not a regular directory.",
            ));
        }
        Ok(Self {
            root: root.to_path_buf(),
        })
    }

    fn validate_source(&self, source: &ImageImportSource) -> Result<PreparedAsset, StorageError> {
        let bytes = read_source(&source.source)?;
        let format = image::guess_format(&bytes)
            .map_err(|_| invalid("The selected file is not a supported image."))?;
        let (mime_type, extension) = format_details(format)
            .ok_or_else(|| invalid("Only PNG, JPEG, GIF, and WebP images are supported."))?;
        if source
            .declared_mime_type
            .as_deref()
            .is_some_and(|declared| declared != mime_type)
        {
            return Err(invalid(
                "The declared image type does not match the decoded image.",
            ));
        }
        let decoded = image::load_from_memory_with_format(&bytes, format)
            .map_err(|_| invalid("The image data is truncated or could not be decoded."))?;
        let (pixel_width, pixel_height) = decoded.dimensions();
        let content_hash = sha256(&bytes);
        let relative_path = format!("{content_hash}.{extension}");
        let display_width = DEFAULT_DISPLAY_WIDTH.max(MIN_IMAGE_DISPLAY_WIDTH);
        let image = NoteImage::try_new(
            content_hash,
            relative_path,
            source.original_name.clone(),
            mime_type,
            u64::try_from(bytes.len())
                .map_err(|_| invalid("The image byte length is too large."))?,
            pixel_width,
            pixel_height,
            display_width,
        )
        .map_err(StorageError::Domain)?;
        Ok(PreparedAsset { bytes, image })
    }

    fn publish(&self, prepared: &PreparedAsset) -> Result<bool, StorageError> {
        let final_path = self.root.join(prepared.image.relative_path());
        if final_path.exists() {
            verify_regular_file(&final_path)?;
            let existing = read_bounded_file(&final_path, MAX_IMAGE_BYTES)?;
            if existing != prepared.bytes {
                return Err(internal_message(
                    "A Notes image asset does not match its content hash.",
                ));
            }
            return Ok(false);
        }

        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temp_name = format!(
            ".{}.{}.{}.tmp",
            prepared.image.content_hash(),
            std::process::id(),
            sequence
        );
        let temp_path = self.root.join(temp_name);
        let publication = (|| {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temp_path)
                .map_err(unavailable)?;
            file.write_all(&prepared.bytes).map_err(unavailable)?;
            file.sync_all().map_err(unavailable)?;
            drop(file);
            match fs::rename(&temp_path, &final_path) {
                Ok(()) => Ok(true),
                Err(_) if final_path.exists() => {
                    let _ = fs::remove_file(&temp_path);
                    verify_regular_file(&final_path)?;
                    let existing = read_bounded_file(&final_path, MAX_IMAGE_BYTES)?;
                    if existing == prepared.bytes {
                        Ok(false)
                    } else {
                        Err(internal_message(
                            "A Notes image asset does not match its content hash.",
                        ))
                    }
                }
                Err(error) => Err(unavailable(error)),
            }
        })();
        if publication.is_err() {
            let _ = fs::remove_file(temp_path);
        }
        publication
    }
}

impl ImageAssetPort for LocalImageAssets {
    fn prepare(&self, sources: &[ImageImportSource]) -> Result<Vec<PublishedImage>, StorageError> {
        if sources.is_empty() || sources.len() > MAX_IMAGE_BATCH_ITEMS {
            return Err(invalid(
                "An image batch must contain between 1 and 128 images.",
            ));
        }

        let mut total_bytes = 0_u64;
        for source in sources {
            total_bytes = total_bytes
                .checked_add(source_length(&source.source)?)
                .ok_or_else(|| invalid("The image batch byte length overflowed."))?;
            if total_bytes > MAX_IMAGE_BATCH_BYTES {
                return Err(invalid("The image batch exceeds 64 MiB."));
            }
        }

        let mut prepared = Vec::with_capacity(sources.len());
        for source in sources {
            let asset = self.validate_source(source)?;
            prepared.push(asset);
        }

        let mut published = Vec::with_capacity(prepared.len());
        for asset in &prepared {
            match self.publish(asset) {
                Ok(newly_created) => published.push(PublishedImage {
                    image: asset.image.clone(),
                    newly_created,
                }),
                Err(error) => {
                    self.rollback(&published);
                    return Err(error);
                }
            }
        }
        Ok(published)
    }

    fn read(&self, image: &NoteImage) -> Result<Vec<u8>, StorageError> {
        let path = self.root.join(image.relative_path());
        verify_regular_file(&path)?;
        let bytes = read_bounded_file(&path, MAX_IMAGE_BYTES)?;
        if u64::try_from(bytes.len()).ok() != Some(image.byte_length())
            || sha256(&bytes) != image.content_hash()
        {
            return Err(internal_message(
                "The Notes image asset failed integrity verification.",
            ));
        }
        Ok(bytes)
    }

    fn contains(&self, image: &NoteImage) -> bool {
        // The reference names the exact file a later read would open, so the
        // path decides: a hash whose bytes were reconciled away is gone. The
        // claimed length has to agree as well -- a reference that lies about it
        // would land a row whose every read fails integrity verification.
        let path = self.root.join(image.relative_path());
        verify_regular_file(&path).is_ok()
            && fs::symlink_metadata(&path)
                .is_ok_and(|metadata| metadata.len() == image.byte_length())
    }

    fn rollback(&self, images: &[PublishedImage]) {
        for published in images.iter().filter(|image| image.newly_created) {
            let path = self.root.join(published.image.relative_path());
            if verify_regular_file(&path).is_ok() {
                let _ = fs::remove_file(path);
            }
        }
    }

    fn reconcile(&self, live_hashes: &BTreeSet<String>) -> Result<(), StorageError> {
        for entry in fs::read_dir(&self.root).map_err(unavailable)? {
            let entry = entry.map_err(unavailable)?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(unavailable)?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(unavailable_message(
                    "The Notes image directory contains an unsafe entry.",
                ));
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let hash = name.split_once('.').map(|(hash, _)| hash);
            if hash.is_none_or(|hash| !live_hashes.contains(hash)) {
                fs::remove_file(entry.path()).map_err(unavailable)?;
            }
        }
        Ok(())
    }
}

fn read_source(source: &ImageSource) -> Result<Vec<u8>, StorageError> {
    match source {
        ImageSource::Bytes(bytes) => {
            validate_byte_length(bytes.len())?;
            Ok(bytes.clone())
        }
        ImageSource::Path(path) => {
            let path_metadata = fs::symlink_metadata(path).map_err(unavailable)?;
            if is_link_or_reparse(&path_metadata) || !path_metadata.is_file() {
                return Err(invalid("The selected image is not a regular file."));
            }
            let file = File::open(path).map_err(unavailable)?;
            let before = file.metadata().map_err(unavailable)?;
            validate_byte_length(
                usize::try_from(before.len())
                    .map_err(|_| invalid("The image byte length is too large."))?,
            )?;
            let mut bytes = Vec::new();
            (&file)
                .take(MAX_IMAGE_BYTES.saturating_add(1))
                .read_to_end(&mut bytes)
                .map_err(unavailable)?;
            if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_IMAGE_BYTES {
                return Err(invalid("The image exceeds 20 MiB."));
            }
            let after = file.metadata().map_err(unavailable)?;
            if before.len() != after.len()
                || before.modified().ok() != after.modified().ok()
                || before.permissions().readonly() != after.permissions().readonly()
            {
                return Err(invalid("The selected image changed while it was read."));
            }
            Ok(bytes)
        }
    }
}

fn source_length(source: &ImageSource) -> Result<u64, StorageError> {
    let length = match source {
        ImageSource::Bytes(bytes) => u64::try_from(bytes.len())
            .map_err(|_| invalid("The image byte length is too large."))?,
        ImageSource::Path(path) => {
            verify_regular_file(path)?;
            fs::metadata(path).map_err(unavailable)?.len()
        }
    };
    if !(1..=MAX_IMAGE_BYTES).contains(&length) {
        return Err(invalid("The image must be between 1 byte and 20 MiB."));
    }
    Ok(length)
}

fn read_bounded_file(path: &Path, maximum: u64) -> Result<Vec<u8>, StorageError> {
    let file = File::open(path).map_err(unavailable)?;
    let mut bytes = Vec::new();
    file.take(maximum.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(unavailable)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > maximum {
        return Err(invalid("The image exceeds 20 MiB."));
    }
    Ok(bytes)
}

fn verify_regular_file(path: &Path) -> Result<(), StorageError> {
    let metadata = fs::symlink_metadata(path).map_err(unavailable)?;
    if is_link_or_reparse(&metadata) || !metadata.is_file() {
        return Err(invalid("The selected image is not a regular file."));
    }
    Ok(())
}

#[cfg(windows)]
fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn validate_byte_length(length: usize) -> Result<(), StorageError> {
    let length =
        u64::try_from(length).map_err(|_| invalid("The image byte length is too large."))?;
    if !(1..=MAX_IMAGE_BYTES).contains(&length) {
        return Err(invalid("The image must be between 1 byte and 20 MiB."));
    }
    Ok(())
}

fn format_details(format: ImageFormat) -> Option<(&'static str, &'static str)> {
    match format {
        ImageFormat::Png => Some(("image/png", "png")),
        ImageFormat::Jpeg => Some(("image/jpeg", "jpg")),
        ImageFormat::Gif => Some(("image/gif", "gif")),
        ImageFormat::WebP => Some(("image/webp", "webp")),
        _ => None,
    }
}

fn sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

fn invalid(message: impl Into<String>) -> StorageError {
    StorageError::Domain(DomainError::InvalidImage(message.into()))
}

fn unavailable(error: impl std::fmt::Display) -> StorageError {
    StorageError::Unavailable(error.to_string())
}

fn unavailable_message(message: impl Into<String>) -> StorageError {
    StorageError::Unavailable(message.into())
}

fn internal_message(message: impl Into<String>) -> StorageError {
    StorageError::Internal(message.into())
}
