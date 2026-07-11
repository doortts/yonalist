use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};
use fs4::FileExt;
use image::codecs::gif::GifDecoder;
use image::codecs::png::PngDecoder;
use image::codecs::webp::WebPDecoder;
use image::{AnimationDecoder, ImageDecoder, ImageFormat, ImageReader, Limits};
use rusqlite::Connection;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufReader, Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::notes::types::NoteAttachment;

pub(crate) const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
pub(crate) const MAX_ATTACHMENT_PIXELS: u64 = 40_000_000;
pub(crate) const MAX_ATTACHMENT_FRAMES: u64 = 256;
pub(crate) const MAX_ATTACHMENT_CUMULATIVE_PIXELS: u64 = 40_000_000;
static IMPORT_BUDGET_LOCK: Mutex<()> = Mutex::new(());
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy)]
pub(crate) struct ValidationLimits {
    pub(crate) max_bytes: u64,
    pub(crate) max_pixels: u64,
    pub(crate) max_frames: u64,
    pub(crate) max_cumulative_pixels: u64,
}

impl ValidationLimits {
    pub(crate) const DEFAULT: Self = Self {
        max_bytes: MAX_ATTACHMENT_BYTES,
        max_pixels: MAX_ATTACHMENT_PIXELS,
        max_frames: MAX_ATTACHMENT_FRAMES,
        max_cumulative_pixels: MAX_ATTACHMENT_CUMULATIVE_PIXELS,
    };
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ValidatedImage {
    pub(crate) mime_type: &'static str,
    pub(crate) extension: &'static str,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) byte_size: u64,
    pub(crate) content_hash: String,
}

#[derive(Debug)]
pub(crate) struct PreparedAttachment {
    pub(crate) bytes: Vec<u8>,
    pub(crate) original_name: String,
    pub(crate) image: ValidatedImage,
}

fn supported_format(format: ImageFormat) -> Option<(&'static str, &'static str)> {
    match format {
        ImageFormat::Png => Some(("image/png", "png")),
        ImageFormat::Jpeg => Some(("image/jpeg", "jpg")),
        ImageFormat::WebP => Some(("image/webp", "webp")),
        ImageFormat::Gif => Some(("image/gif", "gif")),
        _ => None,
    }
}

fn extension_matches(format: ImageFormat, extension: &str) -> bool {
    match format {
        ImageFormat::Jpeg => matches!(extension, "jpg" | "jpeg"),
        ImageFormat::Png => extension == "png",
        ImageFormat::WebP => extension == "webp",
        ImageFormat::Gif => extension == "gif",
        _ => false,
    }
}

fn decoder_limits(dimensions: (u32, u32), limits: ValidationLimits) -> Limits {
    let mut decode_limits = Limits::default();
    decode_limits.max_image_width = Some(dimensions.0);
    decode_limits.max_image_height = Some(dimensions.1);
    decode_limits.max_alloc = Some(limits.max_pixels.saturating_mul(8));
    decode_limits
}

fn validate_animation_frames<'a>(
    frames: impl Iterator<Item = image::ImageResult<image::Frame>> + 'a,
    limits: ValidationLimits,
) -> Result<(), String> {
    let mut frame_count = 0_u64;
    let mut cumulative_pixels = 0_u64;
    for frame in frames {
        let frame = frame.map_err(|error| {
            format!("Could not decode a Notes attachment animation frame: {error}")
        })?;
        frame_count = frame_count.checked_add(1).ok_or_else(|| {
            "The Notes attachment animation frame count is too large.".to_string()
        })?;
        if frame_count > limits.max_frames {
            return Err(format!(
                "Notes attachment animations must contain at most {} frames.",
                limits.max_frames
            ));
        }
        let frame_pixels = u64::from(frame.buffer().width())
            .checked_mul(u64::from(frame.buffer().height()))
            .ok_or_else(|| {
                "The Notes attachment animation decoded pixel count is too large.".to_string()
            })?;
        cumulative_pixels = cumulative_pixels.checked_add(frame_pixels).ok_or_else(|| {
            "The Notes attachment animation decoded pixel count is too large.".to_string()
        })?;
        if cumulative_pixels > limits.max_cumulative_pixels {
            return Err(format!(
                "Notes attachment animations must contain at most {} cumulative decoded pixels.",
                limits.max_cumulative_pixels
            ));
        }
    }
    if frame_count == 0 {
        return Err("A Notes attachment animation must contain at least one frame.".to_string());
    }
    Ok(())
}

fn fully_decode_image(
    format: ImageFormat,
    bytes: &[u8],
    dimensions: (u32, u32),
    limits: ValidationLimits,
) -> Result<(), String> {
    match format {
        ImageFormat::Gif => {
            let mut decoder = GifDecoder::new(BufReader::new(Cursor::new(bytes)))
                .map_err(|error| format!("Could not decode the Notes attachment image: {error}"))?;
            decoder
                .set_limits(decoder_limits(dimensions, limits))
                .map_err(|error| format!("Could not limit the Notes attachment image: {error}"))?;
            validate_animation_frames(decoder.into_frames(), limits)
        }
        ImageFormat::WebP => {
            let mut decoder = WebPDecoder::new(BufReader::new(Cursor::new(bytes)))
                .map_err(|error| format!("Could not decode the Notes attachment image: {error}"))?;
            decoder
                .set_limits(decoder_limits(dimensions, limits))
                .map_err(|error| format!("Could not limit the Notes attachment image: {error}"))?;
            if decoder.has_animation() {
                validate_animation_frames(decoder.into_frames(), limits)
            } else {
                let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
                reader.limits(decoder_limits(dimensions, limits));
                reader.decode().map(|_| ()).map_err(|error| {
                    format!("Could not decode the Notes attachment image: {error}")
                })
            }
        }
        ImageFormat::Png => {
            let mut decoder = PngDecoder::new(BufReader::new(Cursor::new(bytes)))
                .map_err(|error| format!("Could not decode the Notes attachment image: {error}"))?;
            decoder
                .set_limits(decoder_limits(dimensions, limits))
                .map_err(|error| format!("Could not limit the Notes attachment image: {error}"))?;
            if decoder
                .is_apng()
                .map_err(|error| format!("Could not inspect the Notes attachment image: {error}"))?
            {
                let decoder = decoder.apng().map_err(|error| {
                    format!("Could not decode the Notes attachment animation: {error}")
                })?;
                validate_animation_frames(decoder.into_frames(), limits)
            } else {
                let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
                reader.limits(decoder_limits(dimensions, limits));
                reader.decode().map(|_| ()).map_err(|error| {
                    format!("Could not decode the Notes attachment image: {error}")
                })
            }
        }
        ImageFormat::Jpeg => {
            let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
            reader.limits(decoder_limits(dimensions, limits));
            reader
                .decode()
                .map(|_| ())
                .map_err(|error| format!("Could not decode the Notes attachment image: {error}"))
        }
        _ => Err("The Notes attachment image format is unsupported.".to_string()),
    }
}

pub(crate) fn validate_image_bytes(
    source_path: &Path,
    bytes: &[u8],
    limits: ValidationLimits,
) -> Result<ValidatedImage, String> {
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| {
            "Notes attachment images must have a supported file extension.".to_string()
        })?;
    if extension == "svg" {
        return Err("SVG Notes attachments are not supported.".to_string());
    }
    let byte_size = u64::try_from(bytes.len())
        .map_err(|_| "The Notes attachment byte size is too large.".to_string())?;
    if byte_size == 0 || byte_size > limits.max_bytes {
        return Err(format!(
            "Notes attachment images must contain between 1 and {} bytes.",
            limits.max_bytes
        ));
    }

    let format = image::guess_format(bytes)
        .map_err(|error| format!("Could not decode the Notes attachment image format: {error}"))?;
    let (mime_type, canonical_extension) = supported_format(format).ok_or_else(|| {
        "Only PNG, JPEG, WebP, and GIF Notes attachment images are supported.".to_string()
    })?;
    if !extension_matches(format, &extension) {
        return Err(format!(
            "The Notes attachment file extension .{extension} does not match its decoded image format."
        ));
    }

    let dimensions = ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|error| format!("Could not decode the Notes attachment dimensions: {error}"))?;
    let pixels = u64::from(dimensions.0)
        .checked_mul(u64::from(dimensions.1))
        .ok_or_else(|| "The Notes attachment decoded pixel count is too large.".to_string())?;
    if dimensions.0 == 0 || dimensions.1 == 0 || pixels > limits.max_pixels {
        return Err(format!(
            "Notes attachment images must contain between 1 and {} decoded pixels.",
            limits.max_pixels
        ));
    }

    fully_decode_image(format, bytes, dimensions, limits)?;

    Ok(ValidatedImage {
        mime_type,
        extension: canonical_extension,
        width: dimensions.0,
        height: dimensions.1,
        byte_size,
        content_hash: format!("{:x}", Sha256::digest(bytes)),
    })
}

fn canonical_relative_path(content_hash: &str, mime_type: &str) -> Result<String, String> {
    if content_hash.len() != 64
        || !content_hash
            .bytes()
            .all(|value| value.is_ascii_digit() || matches!(value, b'a'..=b'f'))
    {
        return Err("A Notes attachment content hash must be lowercase SHA-256 hex.".to_string());
    }
    let extension = match mime_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => return Err("The Notes attachment MIME type is unsupported.".to_string()),
    };
    Ok(format!("notes-assets/{content_hash}.{extension}"))
}

pub(crate) fn resolve_owned_asset_path(
    metadata_dir: &Path,
    relative_path: &str,
    content_hash: &str,
    mime_type: &str,
) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    let components = relative.components().collect::<Vec<_>>();
    if components.len() != 2
        || components[0] != Component::Normal("notes-assets".as_ref())
        || !matches!(components[1], Component::Normal(_))
    {
        return Err("A Notes attachment path must be a safe owned relative path.".to_string());
    }
    if relative_path != canonical_relative_path(content_hash, mime_type)? {
        return Err("A Notes attachment path does not match its hash and MIME type.".to_string());
    }
    Ok(metadata_dir.join(relative))
}

fn read_bounded(mut reader: impl Read, max_bytes: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    Read::by_ref(&mut reader)
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read the Notes attachment image: {error}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!(
            "Notes attachment images must contain at most {max_bytes} bytes."
        ));
    }
    Ok(bytes)
}

fn prepare_source_attachment_with_budget(source_path: &str) -> Result<PreparedAttachment, String> {
    let _budget = IMPORT_BUDGET_LOCK
        .lock()
        .map_err(|_| "The Notes attachment import budget is unavailable.".to_string())?;
    if source_path.trim().is_empty() {
        return Err("A Notes attachment source path is required.".to_string());
    }
    let path = Path::new(source_path);
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Could not inspect the Notes attachment source: {error}"))?;
    if !metadata.is_file() {
        return Err("A Notes attachment source must be a regular file.".to_string());
    }
    let original_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "A Notes attachment source must name a file.".to_string())?
        .to_string();
    let file = File::open(path)
        .map_err(|error| format!("Could not open the Notes attachment image: {error}"))?;
    let bytes = read_bounded(file, MAX_ATTACHMENT_BYTES)?;
    let image = validate_image_bytes(path, &bytes, ValidationLimits::DEFAULT)?;
    Ok(PreparedAttachment {
        bytes,
        original_name,
        image,
    })
}

#[cfg(test)]
pub(crate) fn prepare_source_attachment(source_path: &str) -> Result<PreparedAttachment, String> {
    prepare_source_attachment_with_budget(source_path)
}

fn safe_owned_file_name(relative_path: &str) -> Result<&str, String> {
    let relative = Path::new(relative_path);
    let components = relative.components().collect::<Vec<_>>();
    if components.len() != 2
        || components[0] != Component::Normal("notes-assets".as_ref())
        || !matches!(components[1], Component::Normal(_))
    {
        return Err("A Notes attachment path must be a safe owned relative path.".to_string());
    }
    let file_name = relative
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "A Notes attachment owned file name must be UTF-8.".to_string())?;
    let (hash, extension) = file_name
        .split_once('.')
        .ok_or_else(|| "A Notes attachment owned file name is invalid.".to_string())?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|value| value.is_ascii_digit() || matches!(value, b'a'..=b'f'))
        || !matches!(extension, "png" | "jpg" | "webp" | "gif")
    {
        return Err("A Notes attachment owned file name is invalid.".to_string());
    }
    Ok(file_name)
}

pub(crate) struct AttachmentStorageLease {
    _lock_file: File,
    assets: Dir,
}

impl AttachmentStorageLease {
    pub(crate) fn acquire(vault_path: &str) -> Result<Self, String> {
        let metadata_path = crate::metadata_dir(vault_path);
        fs::create_dir_all(&metadata_path)
            .map_err(|error| format!("Could not create the Notes metadata directory: {error}"))?;
        let metadata = Dir::open_ambient_dir(&metadata_path, ambient_authority())
            .map_err(|error| format!("Could not open the Notes metadata directory: {error}"))?;

        let mut lock_options = OpenOptions::new();
        lock_options
            .read(true)
            .write(true)
            .create(true)
            .follow(FollowSymlinks::No);
        let lock_file = metadata
            .open_with(".notes-assets.lock", &lock_options)
            .map_err(|error| format!("Could not open the Notes attachment storage lock: {error}"))?
            .into_std();
        if !lock_file
            .metadata()
            .map_err(|error| {
                format!("Could not inspect the Notes attachment storage lock: {error}")
            })?
            .is_file()
        {
            return Err("The Notes attachment storage lock must be a regular file.".to_string());
        }
        FileExt::lock(&lock_file)
            .map_err(|error| format!("Could not lock the Notes attachment storage: {error}"))?;

        let assets = match metadata.open_dir_nofollow("notes-assets") {
            Ok(assets) => assets,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match metadata.create_dir("notes-assets") {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => {
                        return Err(format!(
                            "Could not create the Notes attachment directory: {error}"
                        ))
                    }
                }
                metadata.open_dir_nofollow("notes-assets").map_err(|error| {
                    format!(
                        "The Notes attachment directory must be an owned directory, not a file or symlink: {error}"
                    )
                })?
            }
            Err(error) => {
                return Err(format!(
                    "The Notes attachment directory must be an owned directory, not a file or symlink: {error}"
                ))
            }
        };

        Ok(Self {
            _lock_file: lock_file,
            assets,
        })
    }

    pub(crate) fn prepare_source_attachment(
        &self,
        source_path: &str,
    ) -> Result<PreparedAttachment, String> {
        prepare_source_attachment_with_budget(source_path)
    }

    fn open_owned_file(&self, file_name: &str) -> Result<cap_std::fs::File, String> {
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        self.assets
            .open_with(file_name, &options)
            .map_err(|error| format!("Could not open the Notes attachment image: {error}"))
    }

    #[cfg(unix)]
    fn sync_directory(&self) -> Result<(), String> {
        self.assets
            .try_clone()
            .and_then(|directory| directory.into_std_file().sync_all())
            .map_err(|error| format!("Could not sync the Notes attachment directory: {error}"))
    }

    #[cfg(not(unix))]
    fn sync_directory(&self) -> Result<(), String> {
        Ok(())
    }

    pub(crate) fn publish_attachment_bytes(
        &self,
        prepared: &PreparedAttachment,
    ) -> Result<String, String> {
        let relative_path =
            canonical_relative_path(&prepared.image.content_hash, prepared.image.mime_type)?;
        let target_name = safe_owned_file_name(&relative_path)?.to_string();
        if let Ok(existing) = self.open_owned_file(&target_name) {
            let existing = read_bounded(existing, MAX_ATTACHMENT_BYTES)?;
            if format!("{:x}", Sha256::digest(&existing)) == prepared.image.content_hash {
                return Ok(relative_path);
            }
        }

        let (temporary_name, mut temporary) = (0..100)
            .find_map(|_| {
                let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
                let name = format!(".attachment-{}-{sequence}", std::process::id());
                let mut options = OpenOptions::new();
                options
                    .write(true)
                    .create_new(true)
                    .follow(FollowSymlinks::No);
                match self.assets.open_with(&name, &options) {
                    Ok(file) => Some(Ok((name, file))),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                    Err(error) => Some(Err(error)),
                }
            })
            .transpose()
            .map_err(|error| {
                format!("Could not create a Notes attachment temporary file: {error}")
            })?
            .ok_or_else(|| {
                "Could not allocate a unique Notes attachment temporary file.".to_string()
            })?;

        let publish_result = (|| {
            temporary.write_all(&prepared.bytes).map_err(|error| {
                format!("Could not write a Notes attachment temporary file: {error}")
            })?;
            temporary
                .flush()
                .and_then(|_| temporary.sync_all())
                .map_err(|error| {
                    format!("Could not sync a Notes attachment temporary file: {error}")
                })?;
            drop(temporary);
            self.assets
                .rename(&temporary_name, &self.assets, &target_name)
                .map_err(|error| {
                    format!("Could not publish the Notes attachment atomically: {error}")
                })?;
            self.sync_directory()?;
            Ok(relative_path)
        })();
        if publish_result.is_err() {
            let _ = self.assets.remove_file_or_symlink(&temporary_name);
        }
        publish_result
    }

    pub(crate) fn read_validated_attachment_bytes(
        &self,
        attachment: &NoteAttachment,
    ) -> Result<Vec<u8>, String> {
        resolve_owned_asset_path(
            Path::new("."),
            &attachment.relative_path,
            &attachment.content_hash,
            &attachment.mime_type,
        )?;
        let file_name = safe_owned_file_name(&attachment.relative_path)?;
        let file = self.open_owned_file(file_name)?;
        if !file
            .metadata()
            .map_err(|error| format!("Could not inspect the Notes attachment file: {error}"))?
            .is_file()
        {
            return Err("A Notes attachment owned path must contain a regular file.".to_string());
        }
        let bytes = read_bounded(file, MAX_ATTACHMENT_BYTES)?;
        let validated = validate_image_bytes(
            Path::new(&attachment.relative_path),
            &bytes,
            ValidationLimits::DEFAULT,
        )?;
        if validated.content_hash != attachment.content_hash
            || validated.mime_type != attachment.mime_type
            || validated.byte_size != attachment.byte_size as u64
            || i64::from(validated.width) != attachment.intrinsic_width
            || i64::from(validated.height) != attachment.intrinsic_height
        {
            return Err(
                "The Notes attachment file no longer matches its stored metadata.".to_string(),
            );
        }
        Ok(bytes)
    }
}

#[cfg(test)]
pub(crate) fn publish_attachment_bytes(
    vault_path: &str,
    prepared: &PreparedAttachment,
) -> Result<String, String> {
    AttachmentStorageLease::acquire(vault_path)?.publish_attachment_bytes(prepared)
}

#[derive(Deserialize)]
struct AttachmentPathSnapshot {
    relative_path: String,
    content_hash: String,
    mime_type: String,
}

fn insert_reachable_path(
    reachable: &mut HashSet<String>,
    snapshot: AttachmentPathSnapshot,
) -> Result<(), String> {
    resolve_owned_asset_path(
        Path::new("."),
        &snapshot.relative_path,
        &snapshot.content_hash,
        &snapshot.mime_type,
    )?;
    reachable.insert(snapshot.relative_path);
    Ok(())
}

fn reachable_asset_paths(connection: &Connection) -> Result<HashSet<String>, String> {
    let mut reachable = HashSet::new();
    {
        let mut statement = connection
            .prepare("SELECT relative_path, content_hash, mime_type FROM notes_attachments")
            .map_err(|error| {
                format!("Could not prepare Notes attachment reconciliation: {error}")
            })?;
        let rows = statement
            .query_map([], |row| {
                Ok(AttachmentPathSnapshot {
                    relative_path: row.get(0)?,
                    content_hash: row.get(1)?,
                    mime_type: row.get(2)?,
                })
            })
            .map_err(|error| format!("Could not read Notes attachment reconciliation: {error}"))?;
        for row in rows {
            insert_reachable_path(
                &mut reachable,
                row.map_err(|error| {
                    format!("Could not collect Notes attachment reconciliation: {error}")
                })?,
            )?;
        }
    }
    {
        let mut statement = connection
            .prepare(
                "SELECT before_json, after_json FROM notes_history_changes \
                 WHERE table_name = 'notes_attachments'",
            )
            .map_err(|error| {
                format!("Could not prepare Notes attachment history reachability: {error}")
            })?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            })
            .map_err(|error| {
                format!("Could not read Notes attachment history reachability: {error}")
            })?;
        for row in rows {
            let (before, after) = row.map_err(|error| {
                format!("Could not collect Notes attachment history reachability: {error}")
            })?;
            for snapshot in [before, after].into_iter().flatten() {
                let snapshot =
                    serde_json::from_str::<AttachmentPathSnapshot>(&snapshot).map_err(|error| {
                        format!("Could not decode attachment history reachability: {error}")
                    })?;
                insert_reachable_path(&mut reachable, snapshot)?;
            }
        }
    }
    Ok(reachable)
}

fn attachment_path_is_reachable(
    connection: &Connection,
    relative_path: &str,
) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(\
               SELECT 1 FROM notes_attachments WHERE relative_path = ?1 \
               UNION ALL \
               SELECT 1 FROM notes_history_changes \
               WHERE table_name = 'notes_attachments' AND (\
                 json_extract(before_json, '$.relative_path') = ?1 OR \
                 json_extract(after_json, '$.relative_path') = ?1\
               )\
             )",
            [relative_path],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not inspect Notes attachment reachability: {error}"))
}

impl AttachmentStorageLease {
    pub(crate) fn reconcile_attachment_files(
        &self,
        connection: &Connection,
    ) -> Result<usize, String> {
        let reachable = reachable_asset_paths(connection)?;
        let entries = self.assets.entries().map_err(|error| {
            format!("Could not inspect the Notes attachment directory: {error}")
        })?;
        let mut removed = 0;
        for entry in entries {
            let entry = entry
                .map_err(|error| format!("Could not inspect a Notes attachment file: {error}"))?;
            if entry
                .file_type()
                .map_err(|error| format!("Could not inspect a Notes attachment entry: {error}"))?
                .is_dir()
            {
                continue;
            }
            let file_name = entry.file_name();
            let relative = file_name
                .to_str()
                .map(|name| format!("notes-assets/{name}"));
            if relative
                .as_ref()
                .is_some_and(|path| reachable.contains(path))
            {
                continue;
            }
            self.assets
                .remove_file_or_symlink(&file_name)
                .map_err(|error| {
                    format!("Could not remove an unreferenced Notes attachment: {error}")
                })?;
            removed += 1;
        }
        if removed > 0 {
            self.sync_directory()?;
        }
        Ok(removed)
    }

    pub(crate) fn reconcile_attachment_candidates(
        &self,
        connection: &Connection,
        candidates: &[String],
    ) -> Result<usize, String> {
        let mut removed = 0;
        for relative_path in candidates {
            let file_name = safe_owned_file_name(relative_path)?;
            if attachment_path_is_reachable(connection, relative_path)? {
                continue;
            }
            match self.assets.remove_file_or_symlink(file_name) {
                Ok(()) => removed += 1,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "Could not remove an evicted Notes attachment: {error}"
                    ))
                }
            }
        }
        if removed > 0 {
            self.sync_directory()?;
        }
        Ok(removed)
    }

    pub(crate) fn delete_attachment_files(&self) -> Result<(), String> {
        match self.assets.try_clone().and_then(Dir::remove_open_dir_all) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Could not delete Notes attachment files: {error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_relative_path, prepare_source_attachment, publish_attachment_bytes,
        resolve_owned_asset_path, validate_image_bytes, AttachmentStorageLease, ValidationLimits,
    };
    use crate::notes::commands::{
        notes_clear_history, notes_empty_trash, notes_import_attachment, notes_initialize,
        notes_read_attachment_bytes, notes_redo, notes_remove_attachment, notes_resize_attachment,
        notes_restore_attachment, notes_undo, notes_update_node,
    };
    use crate::notes::history::HISTORY_MAX_ENTRIES;
    use crate::notes::history::{redo, undo};
    use crate::notes::repository::{
        archive_node, connect_notes_db, create_attachment, create_node, load_workspace,
        remove_empty_node, restore_node, soft_delete_node, unarchive_node,
    };
    use crate::notes::types::{
        CreateNodeInput, ImportAttachmentInput, NotesHistoryContext, NotesWorkspaceScope,
        ResizeAttachmentInput, UpdateNodeInput,
    };
    use image::codecs::gif::GifEncoder;
    use image::{DynamicImage, Frame, ImageFormat, Rgba, RgbaImage};
    use rusqlite::params;
    use std::fs;
    use std::io::Cursor;
    use std::path::Path;

    fn encoded(format: ImageFormat) -> Vec<u8> {
        encoded_dimensions(format, 2, 3)
    }

    fn encoded_dimensions(format: ImageFormat, width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(width, height)
            .write_to(&mut bytes, format)
            .expect("encode fixture");
        bytes.into_inner()
    }

    fn encoded_gif_frames(frame_count: usize) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = GifEncoder::new(&mut bytes);
            for index in 0..frame_count {
                let frame = RgbaImage::from_pixel(
                    2,
                    3,
                    Rgba([u8::try_from(index % 255).expect("frame color"), 0, 0, 255]),
                );
                encoder
                    .encode_frame(Frame::new(frame))
                    .expect("encode GIF frame");
            }
        }
        bytes
    }

    const NODE_ID: &str = "11111111-1111-4111-8111-111111111111";
    const ATTACHMENT_ID: &str = "22222222-2222-4222-8222-222222222222";
    const SECOND_ATTACHMENT_ID: &str = "33333333-3333-4333-8333-333333333333";
    const SESSION_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    fn vault_path(temp_dir: &tempfile::TempDir) -> String {
        temp_dir.path().to_string_lossy().into_owned()
    }

    fn seed_node(vault_path: &str) {
        let mut connection = connect_notes_db(vault_path).expect("connect");
        create_node(
            &mut connection,
            CreateNodeInput {
                id: NODE_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "Image node".to_string(),
                note: String::new(),
            },
        )
        .expect("seed node");
    }

    fn history_context(index: usize, command_kind: &str) -> NotesHistoryContext {
        NotesHistoryContext {
            session_id: SESSION_ID.to_string(),
            entry_id: format!("00000000-0000-4000-8000-{index:012x}"),
            command_kind: command_kind.to_string(),
        }
    }

    fn write_source(temp_dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> String {
        let path = temp_dir.path().join(name);
        fs::write(&path, bytes).expect("write source");
        path.to_string_lossy().into_owned()
    }

    fn import_input(id: &str, source_path: String) -> ImportAttachmentInput {
        ImportAttachmentInput {
            id: id.to_string(),
            node_id: NODE_ID.to_string(),
            source_path,
            display_width: None,
        }
    }

    #[test]
    fn notes_attachment_validation_decodes_only_the_supported_raster_formats() {
        for (name, format, mime_type, extension) in [
            ("fixture.png", ImageFormat::Png, "image/png", "png"),
            ("fixture.jpeg", ImageFormat::Jpeg, "image/jpeg", "jpg"),
            ("fixture.webp", ImageFormat::WebP, "image/webp", "webp"),
            ("fixture.gif", ImageFormat::Gif, "image/gif", "gif"),
        ] {
            let bytes = encoded(format);
            let validated =
                validate_image_bytes(Path::new(name), &bytes, ValidationLimits::DEFAULT)
                    .unwrap_or_else(|error| panic!("{name}: {error}"));

            assert_eq!(validated.mime_type, mime_type);
            assert_eq!(validated.extension, extension);
            assert_eq!((validated.width, validated.height), (2, 3));
            assert_eq!(validated.byte_size, bytes.len() as u64);
            assert_eq!(validated.content_hash.len(), 64);
        }

        let animated = encoded_gif_frames(2);
        let validated = validate_image_bytes(
            Path::new("valid-animation.gif"),
            &animated,
            ValidationLimits::DEFAULT,
        )
        .expect("valid animation within budgets");
        assert_eq!((validated.width, validated.height), (2, 3));
    }

    #[test]
    fn notes_attachment_validation_rejects_spoofed_svg_and_truncated_sources() {
        let png = encoded(ImageFormat::Png);
        let spoofed = validate_image_bytes(
            Path::new("actually-jpeg.jpg"),
            &png,
            ValidationLimits::DEFAULT,
        )
        .expect_err("extension spoof must fail");
        assert!(spoofed.to_lowercase().contains("extension"), "{spoofed}");

        let svg = validate_image_bytes(
            Path::new("active.svg"),
            br#"<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>"#,
            ValidationLimits::DEFAULT,
        )
        .expect_err("svg must fail");
        assert!(svg.to_lowercase().contains("svg"), "{svg}");

        let truncated = validate_image_bytes(
            Path::new("broken.png"),
            &png[..png.len() / 2],
            ValidationLimits::DEFAULT,
        )
        .expect_err("truncated image must fail");
        assert!(truncated.to_lowercase().contains("decode"), "{truncated}");

        let animated = encoded_gif_frames(2);
        let second_frame = animated
            .iter()
            .enumerate()
            .filter_map(|(index, byte)| (*byte == 0x2c).then_some(index))
            .nth(1)
            .expect("second GIF image descriptor");
        let corrupt_later_frame = &animated[..second_frame + 12];
        let later_error = validate_image_bytes(
            Path::new("broken-later.gif"),
            corrupt_later_frame,
            ValidationLimits::DEFAULT,
        )
        .expect_err("a corrupt later animation frame must fail validation");
        assert!(
            later_error.to_lowercase().contains("decode"),
            "{later_error}"
        );
    }

    #[test]
    fn notes_attachment_validation_enforces_byte_and_decoded_pixel_limits() {
        let png = encoded(ImageFormat::Png);
        let byte_error = validate_image_bytes(
            Path::new("too-large.png"),
            &png,
            ValidationLimits {
                max_bytes: png.len() as u64 - 1,
                max_pixels: 6,
                ..ValidationLimits::DEFAULT
            },
        )
        .expect_err("byte ceiling must fail");
        assert!(byte_error.to_lowercase().contains("byte"), "{byte_error}");

        let pixel_error = validate_image_bytes(
            Path::new("too-many-pixels.png"),
            &png,
            ValidationLimits {
                max_bytes: png.len() as u64,
                max_pixels: 5,
                ..ValidationLimits::DEFAULT
            },
        )
        .expect_err("pixel ceiling must fail");
        assert!(
            pixel_error.to_lowercase().contains("pixel"),
            "{pixel_error}"
        );

        let animated = encoded_gif_frames(2);
        let frame_error = validate_image_bytes(
            Path::new("too-many-frames.gif"),
            &animated,
            ValidationLimits {
                max_frames: 1,
                max_cumulative_pixels: 6,
                ..ValidationLimits::DEFAULT
            },
        )
        .expect_err("frame ceiling must fail");
        assert!(
            frame_error.to_lowercase().contains("frame"),
            "{frame_error}"
        );

        let cumulative_error = validate_image_bytes(
            Path::new("too-many-frame-pixels.gif"),
            &animated,
            ValidationLimits {
                max_frames: 2,
                max_cumulative_pixels: 11,
                ..ValidationLimits::DEFAULT
            },
        )
        .expect_err("cumulative animation pixel ceiling must fail");
        assert!(
            cumulative_error.to_lowercase().contains("pixel"),
            "{cumulative_error}"
        );
    }

    #[test]
    fn notes_attachment_owned_paths_are_exact_safe_hash_paths() {
        let metadata = Path::new("/vault/.yonalist");
        let hash = "a".repeat(64);
        let relative = format!("notes-assets/{hash}.png");
        assert_eq!(
            resolve_owned_asset_path(metadata, &relative, &hash, "image/png")
                .expect("canonical path"),
            metadata.join(&relative)
        );

        for unsafe_path in [
            format!("../{hash}.png"),
            format!("notes-assets/../{hash}.png"),
            format!("notes-assets/{hash}.jpg"),
            format!("notes-assets/extra/{hash}.png"),
            format!("/tmp/{hash}.png"),
        ] {
            assert!(
                resolve_owned_asset_path(metadata, &unsafe_path, &hash, "image/png").is_err(),
                "accepted unsafe path {unsafe_path}"
            );
        }
    }

    #[test]
    fn notes_attachment_storage_lock_prevents_reconciliation_of_a_published_uncommitted_file() {
        use std::sync::mpsc;
        use std::time::Duration;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let source = write_source(
            &temp_dir,
            "interprocess.png",
            &encoded_dimensions(ImageFormat::Png, 320, 200),
        );
        let first = AttachmentStorageLease::acquire(&vault_path).expect("first storage lease");
        let prepared = first
            .prepare_source_attachment(&source)
            .expect("prepare while leased");
        let relative_path = first
            .publish_attachment_bytes(&prepared)
            .expect("publish before metadata commit");
        let asset_path = temp_dir.path().join(".yonalist").join(&relative_path);

        let (second_ready_tx, second_ready_rx) = mpsc::channel();
        let (second_done_tx, second_done_rx) = mpsc::channel();
        let second_vault = vault_path.clone();
        let second = std::thread::spawn(move || {
            let connection = connect_notes_db(&second_vault).expect("independent connection");
            second_ready_tx.send(()).expect("second ready");
            let second =
                AttachmentStorageLease::acquire(&second_vault).expect("independent storage lease");
            second
                .reconcile_attachment_files(&connection)
                .expect("reconcile after lock handoff");
            second_done_tx.send(()).expect("second done");
        });
        second_ready_rx.recv().expect("second connection ready");
        assert!(
            second_done_rx
                .recv_timeout(Duration::from_millis(100))
                .is_err(),
            "independent reconciliation entered while publication was uncommitted"
        );
        assert!(
            asset_path.is_file(),
            "in-flight published bytes were deleted"
        );

        let mut connection = connect_notes_db(&vault_path).expect("metadata connection");
        create_attachment(
            &mut connection,
            crate::notes::repository::NewAttachment {
                id: ATTACHMENT_ID.to_string(),
                node_id: NODE_ID.to_string(),
                relative_path,
                content_hash: prepared.image.content_hash.clone(),
                original_name: prepared.original_name.clone(),
                mime_type: prepared.image.mime_type.to_string(),
                byte_size: i64::try_from(prepared.image.byte_size).expect("byte size"),
                intrinsic_width: i64::from(prepared.image.width),
                intrinsic_height: i64::from(prepared.image.height),
                display_width: i64::from(prepared.image.width),
            },
        )
        .expect("commit metadata before lock handoff");
        drop(first);
        second_done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("second reconciles after release");
        second.join().expect("second thread");
        assert!(
            asset_path.is_file(),
            "committed shared bytes were reconciled"
        );
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_storage_operations_hold_the_verified_directory_identity() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let external_dir = tempfile::tempdir().expect("external dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let source = write_source(
            &temp_dir,
            "identity.png",
            &encoded_dimensions(ImageFormat::Png, 320, 200),
        );
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");
        let prepared = storage
            .prepare_source_attachment(&source)
            .expect("prepare source");
        let original_root = temp_dir.path().join(".yonalist/notes-assets");
        let renamed_root = temp_dir.path().join(".yonalist/notes-assets-held");
        fs::rename(&original_root, &renamed_root).expect("rename opened asset root");
        let external_name = format!("{}.png", "a".repeat(64));
        let external_sentinel = external_dir.path().join(&external_name);
        fs::write(&external_sentinel, b"external sentinel").expect("external sentinel");
        symlink(external_dir.path(), &original_root).expect("replace path with symlink");

        let relative_path = storage
            .publish_attachment_bytes(&prepared)
            .expect("publish through held directory after path replacement");
        let held_file = renamed_root.join(
            Path::new(&relative_path)
                .file_name()
                .expect("owned file name"),
        );
        assert!(held_file.is_file(), "publish escaped the held directory");
        let mut connection = connect_notes_db(&vault_path).expect("reconciliation connection");
        create_attachment(
            &mut connection,
            crate::notes::repository::NewAttachment {
                id: ATTACHMENT_ID.to_string(),
                node_id: NODE_ID.to_string(),
                relative_path: relative_path.clone(),
                content_hash: prepared.image.content_hash.clone(),
                original_name: prepared.original_name.clone(),
                mime_type: prepared.image.mime_type.to_string(),
                byte_size: i64::try_from(prepared.image.byte_size).expect("byte size"),
                intrinsic_width: i64::from(prepared.image.width),
                intrinsic_height: i64::from(prepared.image.height),
                display_width: i64::from(prepared.image.width),
            },
        )
        .expect("metadata for held file");
        let attachment = crate::notes::repository::attachment_by_id(&connection, ATTACHMENT_ID)
            .expect("read held metadata")
            .expect("held metadata exists");
        assert_eq!(
            storage
                .read_validated_attachment_bytes(&attachment)
                .expect("read through held directory after path replacement"),
            prepared.bytes
        );
        connection
            .execute(
                "DELETE FROM notes_attachments WHERE id = ?1",
                [ATTACHMENT_ID],
            )
            .expect("make held bytes unreachable");
        assert_eq!(
            storage
                .reconcile_attachment_files(&connection)
                .expect("reconcile through held directory"),
            1
        );

        assert!(!held_file.exists(), "held directory entry was not removed");
        assert_eq!(
            fs::read(&external_sentinel).expect("external sentinel remains"),
            b"external sentinel"
        );
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_reconciliation_rejects_a_symlinked_owned_root() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let external_dir = tempfile::tempdir().expect("external dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let sentinel = external_dir.path().join("sentinel.png");
        fs::write(&sentinel, b"external sentinel").expect("sentinel");
        symlink(
            external_dir.path(),
            temp_dir.path().join(".yonalist/notes-assets"),
        )
        .expect("symlink asset root");

        let error = notes_initialize(vault_path).expect_err("symlinked root must fail closed");

        assert!(error.to_lowercase().contains("directory"), "{error}");
        assert_eq!(
            fs::read(&sentinel).expect("external sentinel remains"),
            b"external sentinel"
        );
    }

    #[test]
    fn notes_attachment_import_deduplicates_hashes_orders_workspace_and_bounds_width() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let first_source = write_source(&temp_dir, "first.png", &png);
        let second_source = write_source(&temp_dir, "second.png", &png);

        notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, first_source),
            None,
        )
        .expect("first import");
        let workspace = notes_import_attachment(
            vault_path.clone(),
            import_input(SECOND_ATTACHMENT_ID, second_source),
            None,
        )
        .expect("deduplicated import");
        let attachments = &workspace.attachments_by_node_id[NODE_ID];
        assert_eq!(
            attachments
                .iter()
                .map(|value| value.id.as_str())
                .collect::<Vec<_>>(),
            vec![ATTACHMENT_ID, SECOND_ATTACHMENT_ID]
        );
        assert_eq!(attachments[0].relative_path, attachments[1].relative_path);
        assert_eq!(attachments[0].display_width, 320);
        assert_eq!(
            fs::read_dir(temp_dir.path().join(".yonalist/notes-assets"))
                .expect("asset dir")
                .count(),
            1
        );
        assert_eq!(
            notes_read_attachment_bytes(vault_path.clone(), ATTACHMENT_ID.to_string())
                .expect("validated bytes"),
            png
        );

        for invalid_width in [159, 321] {
            assert!(notes_resize_attachment(
                vault_path.clone(),
                ResizeAttachmentInput {
                    id: ATTACHMENT_ID.to_string(),
                    display_width: invalid_width,
                },
                None,
            )
            .is_err());
        }
        let resized = notes_resize_attachment(
            vault_path,
            ResizeAttachmentInput {
                id: ATTACHMENT_ID.to_string(),
                display_width: 160,
            },
            None,
        )
        .expect("valid resize");
        assert_eq!(
            resized.attachments_by_node_id[NODE_ID][0].display_width,
            160
        );
    }

    #[test]
    fn notes_attachment_import_failures_reconcile_without_deleting_shared_hashes() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let first_png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let second_png = encoded_dimensions(ImageFormat::Png, 321, 200);
        let first_source = write_source(&temp_dir, "shared.png", &first_png);
        let second_source = write_source(&temp_dir, "unshared.png", &second_png);

        let blocked = prepare_source_attachment(&second_source).expect("prepare blocked publish");
        let blocked_relative =
            canonical_relative_path(&blocked.image.content_hash, blocked.image.mime_type)
                .expect("blocked relative path");
        let blocked_target = temp_dir.path().join(".yonalist").join(blocked_relative);
        fs::create_dir_all(&blocked_target).expect("blocking target directory");
        publish_attachment_bytes(&vault_path, &blocked).expect_err("directory target must fail");
        assert!(
            fs::read_dir(temp_dir.path().join(".yonalist/notes-assets"))
                .expect("asset dir")
                .all(|entry| !entry
                    .expect("asset entry")
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".attachment-")),
            "failed publish left a temporary file"
        );
        fs::remove_dir(blocked_target).expect("remove blocking target");

        let imported = notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, first_source.clone()),
            None,
        )
        .expect("shared import");
        let shared_path = temp_dir
            .path()
            .join(".yonalist")
            .join(&imported.attachments_by_node_id[NODE_ID][0].relative_path);

        let connection = connect_notes_db(&vault_path).expect("connect trigger");
        connection
            .execute_batch(
                "CREATE TRIGGER reject_attachment_import BEFORE INSERT ON notes_attachments \
                 BEGIN SELECT RAISE(ABORT, 'blocked attachment metadata'); END;",
            )
            .expect("install rejection");
        drop(connection);

        assert!(notes_import_attachment(
            vault_path.clone(),
            import_input(SECOND_ATTACHMENT_ID, first_source),
            None,
        )
        .is_err());
        assert!(
            shared_path.is_file(),
            "shared hash was deleted after metadata failure"
        );

        let unshared_error = notes_import_attachment(
            vault_path.clone(),
            import_input(SECOND_ATTACHMENT_ID, second_source),
            None,
        )
        .expect_err("metadata failure must surface");
        assert!(
            unshared_error.contains("blocked attachment metadata"),
            "{unshared_error}"
        );
        let entries = fs::read_dir(temp_dir.path().join(".yonalist/notes-assets"))
            .expect("asset dir")
            .collect::<Result<Vec<_>, _>>()
            .expect("asset entries");
        assert_eq!(
            entries.len(),
            1,
            "unshared file or temp file survived reconciliation"
        );

        let broken = write_source(&temp_dir, "broken.png", &first_png[..16]);
        assert!(notes_import_attachment(
            vault_path.clone(),
            import_input(SECOND_ATTACHMENT_ID, broken),
            None,
        )
        .is_err());

        let connection = connect_notes_db(&vault_path).expect("connect orphan");
        connection
            .execute_batch("DROP TRIGGER reject_attachment_import")
            .expect("drop rejection");
        connection
            .execute("DELETE FROM notes_attachments", [])
            .expect("orphan shared file");
        drop(connection);
        notes_initialize(vault_path).expect("startup reconciliation");
        assert!(
            !shared_path.exists(),
            "startup reconciliation kept an orphan"
        );
    }

    #[test]
    fn notes_attachment_history_replays_import_resize_remove_and_restore_metadata() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "history.png", &png);
        let import_context = history_context(1, "importAttachment");

        let imported = notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            Some(import_context),
        )
        .expect("journaled import");
        let asset_path = temp_dir
            .path()
            .join(".yonalist")
            .join(&imported.attachments_by_node_id[NODE_ID][0].relative_path);
        let mut connection = connect_notes_db(&vault_path).expect("connect history");
        let undone =
            undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("undo import");
        assert!(undone.workspace.attachments_by_node_id.is_empty());
        assert!(asset_path.is_file(), "redo-reachable bytes were removed");
        let redone =
            redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("redo import");
        assert_eq!(redone.workspace.attachments_by_node_id[NODE_ID].len(), 1);
        drop(connection);

        let resize_context = history_context(2, "resizeAttachment");
        notes_resize_attachment(
            vault_path.clone(),
            ResizeAttachmentInput {
                id: ATTACHMENT_ID.to_string(),
                display_width: 180,
            },
            Some(resize_context),
        )
        .expect("journaled resize");
        let mut connection = connect_notes_db(&vault_path).expect("connect resize history");
        assert_eq!(
            undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
                .expect("undo resize")
                .workspace
                .attachments_by_node_id[NODE_ID][0]
                .display_width,
            320
        );
        assert_eq!(
            redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
                .expect("redo resize")
                .workspace
                .attachments_by_node_id[NODE_ID][0]
                .display_width,
            180
        );
        drop(connection);

        let remove_context = history_context(3, "removeAttachment");
        notes_remove_attachment(
            vault_path.clone(),
            ATTACHMENT_ID.to_string(),
            Some(remove_context),
        )
        .expect("journaled remove");
        assert!(asset_path.is_file(), "undo-reachable bytes were removed");
        let restored = notes_restore_attachment(
            vault_path.clone(),
            ATTACHMENT_ID.to_string(),
            Some(history_context(4, "restoreAttachment")),
        )
        .expect("explicit history restore");
        assert_eq!(
            restored.attachments_by_node_id[NODE_ID][0].display_width,
            180
        );

        notes_remove_attachment(vault_path.clone(), ATTACHMENT_ID.to_string(), None)
            .expect("permanent metadata removal");
        notes_clear_history(vault_path, SESSION_ID.to_string()).expect("clear history");
        assert!(
            !asset_path.exists(),
            "unreferenced bytes survived history clearing"
        );
    }

    #[test]
    fn notes_attachment_history_rejects_stale_resize_replay_without_mutation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "stale.png", &png);
        notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("import");
        notes_resize_attachment(
            vault_path.clone(),
            ResizeAttachmentInput {
                id: ATTACHMENT_ID.to_string(),
                display_width: 180,
            },
            Some(history_context(1, "resizeAttachment")),
        )
        .expect("journaled resize");
        let mut connection = connect_notes_db(&vault_path).expect("connect");
        connection
            .execute(
                "UPDATE notes_attachments SET display_width = 170 WHERE id = ?1",
                [ATTACHMENT_ID],
            )
            .expect("newer attachment update");

        let error = undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect_err("stale resize undo must conflict");

        assert!(error.to_lowercase().contains("history conflict"), "{error}");
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Active)
                .expect("workspace after conflict")
                .attachments_by_node_id[NODE_ID][0]
                .display_width,
            170
        );
    }

    #[test]
    fn notes_attachment_history_replay_rejects_missing_or_corrupt_owned_bytes_atomically() {
        for (case, replacement) in [
            ("missing", None),
            ("corrupt", Some(b"not an image".as_slice())),
        ] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let vault_path = vault_path(&temp_dir);
            seed_node(&vault_path);
            let png = encoded_dimensions(ImageFormat::Png, 320, 200);
            let source = write_source(&temp_dir, "replay.png", &png);
            let imported = notes_import_attachment(
                vault_path.clone(),
                import_input(ATTACHMENT_ID, source),
                Some(history_context(1, "importAttachment")),
            )
            .expect("journaled import");
            let asset_path = temp_dir
                .path()
                .join(".yonalist")
                .join(&imported.attachments_by_node_id[NODE_ID][0].relative_path);
            notes_undo(
                vault_path.clone(),
                SESSION_ID.to_string(),
                NotesWorkspaceScope::Active,
            )
            .expect("undo import metadata");
            match replacement {
                Some(bytes) => fs::write(&asset_path, bytes).expect("corrupt owned bytes"),
                None => fs::remove_file(&asset_path).expect("remove owned bytes"),
            }

            let error = notes_redo(
                vault_path.clone(),
                SESSION_ID.to_string(),
                NotesWorkspaceScope::Active,
            )
            .expect_err(&format!("{case} bytes must block metadata replay"));

            assert!(
                error.to_lowercase().contains("attachment"),
                "{case}: {error}"
            );
            let connection = connect_notes_db(&vault_path).expect("reopen after replay conflict");
            assert!(
                load_workspace(&connection, NotesWorkspaceScope::Active)
                    .expect("workspace after replay conflict")
                    .attachments_by_node_id
                    .is_empty(),
                "{case} replay partially restored attachment metadata"
            );
            assert!(
                connection
                    .query_row(
                        "SELECT is_undone FROM notes_history_entries WHERE session_id = ?1",
                        [SESSION_ID],
                        |row| row.get::<_, bool>(0),
                    )
                    .expect("history replay state"),
                "{case} replay advanced history despite validation failure"
            );
        }
    }

    #[test]
    fn notes_attachment_non_attachment_history_eviction_reconciles_only_newly_unreachable_bytes() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "evicted.png", &png);
        let imported = notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            Some(history_context(1, "importAttachment")),
        )
        .expect("journaled import");
        let asset_root = temp_dir.path().join(".yonalist/notes-assets");
        let asset_path = temp_dir
            .path()
            .join(".yonalist")
            .join(&imported.attachments_by_node_id[NODE_ID][0].relative_path);
        let unrelated = asset_root.join("unrelated-sentinel");
        fs::write(&unrelated, b"not a managed attachment").expect("write unrelated sentinel");
        let connection = connect_notes_db(&vault_path).expect("remove live metadata");
        connection
            .execute(
                "DELETE FROM notes_attachments WHERE id = ?1",
                [ATTACHMENT_ID],
            )
            .expect("leave bytes reachable only from history");
        drop(connection);

        for index in 0..HISTORY_MAX_ENTRIES {
            notes_update_node(
                vault_path.clone(),
                UpdateNodeInput {
                    id: NODE_ID.to_string(),
                    title: format!("ordinary edit {index}"),
                    note: String::new(),
                },
                Some(history_context(
                    usize::try_from(index + 2).expect("history index"),
                    "updateNode",
                )),
            )
            .expect("ordinary journaled edit");
        }

        assert!(
            !asset_path.exists(),
            "ordinary history eviction left attachment bytes unreachable"
        );
        assert!(
            unrelated.exists(),
            "ordinary mutation performed an unconditional asset directory scan"
        );
    }

    #[test]
    fn notes_attachment_bytes_follow_live_trash_archive_and_reject_tampered_paths() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "lifecycle.png", &png);
        let imported = notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("import");
        let asset_path = temp_dir
            .path()
            .join(".yonalist")
            .join(&imported.attachments_by_node_id[NODE_ID][0].relative_path);

        let mut connection = connect_notes_db(&vault_path).expect("connect lifecycle");
        soft_delete_node(&mut connection, NODE_ID).expect("trash node");
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Trash)
                .expect("trash workspace")
                .attachments_by_node_id[NODE_ID]
                .len(),
            1
        );
        restore_node(&mut connection, NODE_ID).expect("restore node");
        archive_node(&mut connection, NODE_ID).expect("archive node");
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Archive)
                .expect("archive workspace")
                .attachments_by_node_id[NODE_ID]
                .len(),
            1
        );
        unarchive_node(&mut connection, NODE_ID).expect("unarchive node");

        fs::write(&asset_path, &png[..16]).expect("truncate owned file");
        assert!(
            notes_read_attachment_bytes(vault_path.clone(), ATTACHMENT_ID.to_string()).is_err()
        );
        fs::write(&asset_path, &png).expect("repair owned file");

        let secret = temp_dir.path().join(".yonalist/secret.png");
        fs::write(&secret, b"must not be returned").expect("secret");
        connection
            .execute(
                "UPDATE notes_attachments SET relative_path = '../secret.png' WHERE id = ?1",
                params![ATTACHMENT_ID],
            )
            .expect("tamper path");
        drop(connection);
        assert!(
            notes_read_attachment_bytes(vault_path.clone(), ATTACHMENT_ID.to_string()).is_err()
        );

        let mut connection = connect_notes_db(&vault_path).expect("connect cleanup");
        connection
            .execute(
                "DELETE FROM notes_attachments WHERE id = ?1",
                [ATTACHMENT_ID],
            )
            .expect("remove corrupt metadata");
        soft_delete_node(&mut connection, NODE_ID).expect("trash for empty");
        drop(connection);
        notes_empty_trash(vault_path).expect("empty trash");
        assert_eq!(
            fs::read(&secret).expect("secret remains"),
            b"must not be returned"
        );
    }

    #[test]
    fn notes_attachment_empty_trash_removes_valid_unreferenced_owned_bytes() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "trash.png", &png);
        let workspace = notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("import");
        let asset_path = temp_dir
            .path()
            .join(".yonalist")
            .join(&workspace.attachments_by_node_id[NODE_ID][0].relative_path);
        let mut connection = connect_notes_db(&vault_path).expect("connect");
        soft_delete_node(&mut connection, NODE_ID).expect("trash node");
        drop(connection);

        notes_empty_trash(vault_path).expect("empty trash");

        assert!(!asset_path.exists());
    }

    #[test]
    fn notes_attachment_prevents_image_only_nodes_from_being_removed_as_empty() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let connection = connect_notes_db(&vault_path).expect("connect empty seed");
        connection
            .execute(
                "UPDATE notes_nodes SET title = '', note = '' WHERE id = ?1",
                [NODE_ID],
            )
            .expect("empty node text");
        drop(connection);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "not-empty.png", &png);
        notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("import");
        let mut connection = connect_notes_db(&vault_path).expect("connect");

        let error = remove_empty_node(&mut connection, NODE_ID)
            .expect_err("an attached image makes the node non-empty");

        assert!(error.to_lowercase().contains("empty"), "{error}");
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Active)
                .expect("active workspace")
                .attachments_by_node_id[NODE_ID]
                .len(),
            1
        );
    }
}
